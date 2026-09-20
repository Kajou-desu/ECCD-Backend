import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for the four tables the service touches, honouring the
// same uniqueness rules the migration enforces (verified against real Postgres):
// one signal per (session, student, kind); one attendance per (student, date).
const db = vi.hoisted(() => {
  const state = { signals: [], attendance: [], verifications: [], nextId: 1 };
  const sigKey = (w) => w.sessionId_studentId_kind;
  const prisma = {
    attendanceSignal: {
      findUnique: async ({ where }) => {
        const k = sigKey(where);
        return state.signals.find((s) => s.sessionId === k.sessionId && s.studentId === k.studentId && s.kind === k.kind) ?? null;
      },
      upsert: async ({ where, create, update }) => {
        const existing = await prisma.attendanceSignal.findUnique({ where });
        if (existing) return Object.assign(existing, update);
        const row = { id: state.nextId++, ...create };
        state.signals.push(row);
        return row;
      },
    },
    attendance: {
      createMany: async ({ data, skipDuplicates }) => {
        let count = 0;
        for (const d of data) {
          const dup = state.attendance.some((a) => a.studentId === d.studentId && a.date.getTime() === d.date.getTime());
          if (dup && !skipDuplicates) throw Object.assign(new Error("unique"), { code: "P2002" });
          if (!dup) { state.attendance.push({ id: state.nextId++, ...d }); count += 1; }
        }
        return { count };
      },
      findUnique: async ({ where }) => {
        const k = where.studentId_date;
        return state.attendance.find((a) => a.studentId === k.studentId && a.date.getTime() === k.date.getTime()) ?? null;
      },
    },
    attendanceVerification: {
      create: async ({ data }) => { const row = { id: state.nextId++, ...data }; state.verifications.push(row); return row; },
    },
    $transaction: async (cb) => cb(prisma),
  };
  return { state, prisma };
});

vi.mock("../src/lib/prisma.js", () => ({ prisma: db.prisma }));

const { mergeSignal, isSignalPresent, evaluate, recordSignal } = await import(
  "../src/services/attendanceVerification.service.js"
);

const CFG = { faceMaxDistance: 0.5, faceMinMargin: 0.05, bleMinRssi: -70, windowMs: 30_000, minHits: 2 };
const T0 = new Date("2026-09-20T23:30:00.000Z");
const at = (secs) => new Date(T0.getTime() + secs * 1000);
const sig = (score, hits, lastSeenAt) => ({ score, hits, lastSeenAt });

describe("mergeSignal", () => {
  it("starts a run at hits=1 with the raw value", () => {
    expect(mergeSignal(null, -60, T0, CFG)).toEqual({ score: -60, hits: 1, lastSeenAt: T0 });
  });

  it("continues a run within the window: counts the hit and smooths the value", () => {
    const next = mergeSignal(sig(-60, 1, T0), -80, at(5), CFG);
    expect(next.hits).toBe(2);
    expect(next.score).toBe(-70); // halfway between -60 and -80
    expect(next.lastSeenAt).toEqual(at(5));
  });

  it("restarts the run after a gap longer than the window (stale history doesn't carry over)", () => {
    const next = mergeSignal(sig(-40, 9, T0), -80, at(31), CFG);
    expect(next).toEqual({ score: -80, hits: 1, lastSeenAt: at(31) });
  });

  it("a gap of exactly the window still continues", () => {
    expect(mergeSignal(sig(-60, 1, T0), -60, at(30), CFG).hits).toBe(2);
  });
});

describe("isSignalPresent", () => {
  it("face: needs to be fresh, seen enough, and a close-enough match", () => {
    expect(isSignalPresent("face", sig(0.4, 2, T0), at(5), CFG)).toBe(true);
    expect(isSignalPresent("face", sig(0.51, 2, T0), at(5), CFG)).toBe(false); // too far
    expect(isSignalPresent("face", sig(0.5, 2, T0), at(5), CFG)).toBe(true); // boundary inclusive
    expect(isSignalPresent("face", sig(0.4, 1, T0), at(5), CFG)).toBe(false); // one sighting
    expect(isSignalPresent("face", sig(0.4, 2, T0), at(31), CFG)).toBe(false); // stale
    expect(isSignalPresent("face", null, at(5), CFG)).toBe(false);
  });

  it("ble: higher RSSI = nearer, so the direction is the OPPOSITE of face", () => {
    expect(isSignalPresent("ble", sig(-60, 2, T0), at(5), CFG)).toBe(true);
    expect(isSignalPresent("ble", sig(-70, 2, T0), at(5), CFG)).toBe(true); // boundary inclusive
    expect(isSignalPresent("ble", sig(-71, 2, T0), at(5), CFG)).toBe(false); // too far away
    expect(isSignalPresent("ble", sig(-60, 1, T0), at(5), CFG)).toBe(false);
  });
});

describe("evaluate", () => {
  const good = { face: sig(0.4, 2, T0), ble: sig(-60, 2, T0) };
  it("verified only when BOTH signals are present", () => {
    expect(evaluate({ ...good, now: at(5), cfg: CFG })).toBe("verified");
    expect(evaluate({ face: good.face, ble: null, now: at(5), cfg: CFG })).toBe("pending");
    expect(evaluate({ face: null, ble: good.ble, now: at(5), cfg: CFG })).toBe("pending");
    expect(evaluate({ face: null, ble: null, now: at(5), cfg: CFG })).toBe("pending");
  });
  it("one good signal never compensates for a bad one", () => {
    expect(evaluate({ face: sig(0.9, 5, T0), ble: good.ble, now: at(5), cfg: CFG })).toBe("pending");
    expect(evaluate({ face: good.face, ble: sig(-95, 5, T0), now: at(5), cfg: CFG })).toBe("pending");
  });
});

describe("recordSignal (full flow against the in-memory tables)", () => {
  const SESSION = 1;
  const DATE = new Date("2026-09-20T00:00:00.000Z");
  const send = (studentId, kind, value, t) =>
    recordSignal({ sessionId: SESSION, sessionDate: DATE, studentId, kind, value, now: at(t) });

  beforeEach(() => {
    db.state.signals.length = 0;
    db.state.attendance.length = 0;
    db.state.verifications.length = 0;
  });

  it("BLE alone never marks anyone present, however long it's seen", async () => {
    for (let t = 0; t < 20; t += 2) expect((await send(5, "ble", -50, t)).state).toBe("pending");
    expect(db.state.attendance).toHaveLength(0);
  });

  it("face alone never marks anyone present either", async () => {
    for (let t = 0; t < 20; t += 1) expect((await send(5, "face", 0.3, t)).state).toBe("pending");
    expect(db.state.attendance).toHaveLength(0);
  });

  it("marks present once both signals have enough sightings, and writes the audit row", async () => {
    expect((await send(5, "ble", -55, 0)).state).toBe("pending");
    expect((await send(5, "ble", -55, 2)).state).toBe("pending"); // BLE ready, no face yet
    expect((await send(5, "face", 0.4, 3)).state).toBe("pending"); // face hit #1
    const last = await send(5, "face", 0.42, 4); // face hit #2 -> complete
    expect(last.state).toBe("verified");

    expect(db.state.attendance).toHaveLength(1);
    expect(db.state.attendance[0]).toMatchObject({ studentId: 5, date: DATE, status: "present", arrivedAt: at(4) });
    expect(db.state.verifications).toHaveLength(1);
    expect(db.state.verifications[0]).toMatchObject({ sessionId: SESSION, verifiedAt: at(4) });
    expect(db.state.verifications[0].faceDistance).toBeCloseTo(0.41);
    expect(db.state.verifications[0].bleRssi).toBe(-55);
  });

  it("works in either arrival order (face first, then BLE)", async () => {
    await send(5, "face", 0.4, 0);
    await send(5, "face", 0.4, 1);
    await send(5, "ble", -60, 2);
    expect((await send(5, "ble", -60, 3)).state).toBe("verified");
  });

  it("a weak BLE signal (student far away) does not verify", async () => {
    await send(5, "face", 0.3, 0);
    await send(5, "face", 0.3, 1);
    await send(5, "ble", -90, 2);
    expect((await send(5, "ble", -90, 3)).state).toBe("pending");
    expect(db.state.attendance).toHaveLength(0);
  });

  it("a poor face match does not verify even with a strong tag", async () => {
    await send(5, "ble", -50, 0);
    await send(5, "ble", -50, 1);
    await send(5, "face", 0.6, 2);
    expect((await send(5, "face", 0.6, 3)).state).toBe("pending");
  });

  it("does not verify from a stale signal: face seen, BLE arrives 40s later", async () => {
    await send(5, "face", 0.3, 0);
    await send(5, "face", 0.3, 1);
    await send(5, "ble", -50, 40);
    expect((await send(5, "ble", -50, 41)).state).toBe("pending"); // face is now 40s old
  });

  it("a signal gap restarts the hit count (one reading either side of a gap isn't two)", async () => {
    await send(5, "ble", -50, 0);
    expect((await send(5, "ble", -50, 40)).state).toBe("pending"); // hits reset to 1
    await send(5, "face", 0.3, 41);
    expect((await send(5, "face", 0.3, 42)).state).toBe("pending"); // BLE still only 1 hit
    expect((await send(5, "ble", -50, 43)).state).toBe("verified"); // now BLE has 2
  });

  it("never overwrites an existing record (e.g. teacher already marked excused)", async () => {
    db.state.attendance.push({ id: 99, studentId: 5, date: DATE, status: "excused", arrivedAt: null });
    await send(5, "ble", -50, 0);
    await send(5, "ble", -50, 1);
    await send(5, "face", 0.3, 2);
    const res = await send(5, "face", 0.3, 3);

    expect(res.state).toBe("already_recorded");
    expect(db.state.attendance).toHaveLength(1);
    expect(db.state.attendance[0]).toMatchObject({ id: 99, status: "excused" });
    expect(db.state.verifications).toHaveLength(0); // no false "verified by system" evidence
  });

  it("keeps state per student: one student's signals never verify another", async () => {
    await send(5, "ble", -50, 0);
    await send(5, "ble", -50, 1);
    await send(6, "face", 0.3, 2);
    expect((await send(6, "face", 0.3, 3)).state).toBe("pending");
    expect(db.state.attendance).toHaveLength(0);
  });

  it("is idempotent: a verified student who stays in view is not re-marked or double-audited", async () => {
    await send(5, "ble", -50, 0); await send(5, "ble", -50, 1);
    await send(5, "face", 0.3, 2);
    expect((await send(5, "face", 0.3, 3)).state).toBe("verified");
    expect((await send(5, "face", 0.3, 4)).state).toBe("already_recorded");
    expect((await send(5, "ble", -50, 5)).state).toBe("already_recorded");
    expect(db.state.attendance).toHaveLength(1);
    expect(db.state.verifications).toHaveLength(1);
  });
});
