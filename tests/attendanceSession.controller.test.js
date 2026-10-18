import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    attendanceSession: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    pickupCheck: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { getCurrentSession, startSession, stopSession } = await import(
  "../src/controllers/attendanceSession.controller.js"
);

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

// A Teacher with no center yet (their sessions are the shared "no center" ones).
const teacherReq = { user: { id: 3, role: "Teacher" } };
const teacherAt = (centerId, over = {}) => ({ user: { id: 5, role: "Teacher", centerId }, ...over });
const adminReq = (over = {}) => ({ user: { id: 1, role: "Admin" }, ...over });
const TODAY = new Date("2026-09-20T00:00:00.000Z"); // school day for the frozen clock below
const row = (over = {}) => ({
  id: 7,
  date: TODAY,
  status: "active",
  startedAt: new Date("2026-09-19T23:31:00.000Z"),
  endedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // 7:31 AM Manila on 2026-09-20 — still 2026-09-19 in UTC.
  vi.setSystemTime(new Date("2026-09-19T23:31:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("getCurrentSession", () => {
  it("returns null when nothing is active", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await getCurrentSession(teacherReq, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith({ session: null, pickupChecks: [], pickupWindow: { active: false, endsAt: null } });
    expect(prisma.pickupCheck.findMany).not.toHaveBeenCalled(); // nothing to look up without a session
  });

  it("returns the active session without leaking who started it", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue({ ...row(), startedById: 99, centerId: 4 });
    const res = mockRes();
    await getCurrentSession(teacherReq, res, vi.fn());
    const { session } = res.json.mock.calls[0][0];
    expect(session).toMatchObject({ id: 7, date: "2026-09-20", status: "active" });
    expect(session).not.toHaveProperty("startedById");
    expect(session).not.toHaveProperty("centerId");
  });

  it("includes the teacher's open pickup prompts, scoped to their own students", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(row());
    prisma.pickupCheck.findMany.mockResolvedValue([
      { id: 9, studentId: 5, expiresAt: new Date(Date.now() + 12_000), student: { name: "Ana Cruz" } },
    ]);
    const res = mockRes();
    await getCurrentSession(teacherReq, res, vi.fn());

    expect(res.json.mock.calls[0][0].pickupChecks).toEqual([
      { id: 9, studentId: 5, name: "Ana Cruz", expiresInMs: 12_000 },
    ]);
    expect(prisma.pickupCheck.findMany.mock.calls[0][0].where).toMatchObject({
      answeredAt: null,
      student: { teacherId: 3 },
    });
  });

  it("lets an Admin see every open prompt of the center they named", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(row());
    prisma.pickupCheck.findMany.mockResolvedValue([]);
    await getCurrentSession(adminReq({ query: { centerId: "1" } }), mockRes(), vi.fn());
    expect(prisma.pickupCheck.findMany.mock.calls[0][0].where).not.toHaveProperty("student");
  });

  it("passes database errors to next() instead of responding", async () => {
    const err = new Error("db down");
    prisma.attendanceSession.findFirst.mockRejectedValue(err);
    const res = mockRes();
    const next = vi.fn();
    await getCurrentSession(teacherReq, res, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe("startSession", () => {
  it("creates a session dated in the SCHOOL timezone, owned by the token's user", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(null);
    prisma.attendanceSession.create.mockResolvedValue(row());
    const res = mockRes();

    // Hostile body: neither date, owner nor center may come from the client.
    const req = {
      user: { id: 5, role: "Teacher", centerId: 2 },
      body: { date: "1999-01-01", startedById: 1, centerId: 99 },
    };
    await startSession(req, res, vi.fn());

    const { data } = prisma.attendanceSession.create.mock.calls[0][0];
    expect(data).toEqual({ date: TODAY, centerId: 2, startedById: 5 });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("is idempotent: returns today's active session instead of creating another", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(row());
    const res = mockRes();
    await startSession(teacherAt(2), res, vi.fn());
    expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled(); // plain 200
    expect(res.json.mock.calls[0][0].session.id).toBe(7);
  });

  it("closes a leftover session from a previous day, then starts a fresh one", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(row({ id: 3, date: new Date("2026-09-19T00:00:00.000Z") }));
    prisma.attendanceSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.attendanceSession.create.mockResolvedValue(row({ id: 8 }));
    const res = mockRes();
    await startSession(teacherAt(2), res, vi.fn());

    expect(prisma.attendanceSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 3, status: "active" } }),
    );
    expect(prisma.attendanceSession.create).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("returns the winner when a concurrent start trips the one-active-session-per-center index", async () => {
    prisma.attendanceSession.findFirst
      .mockResolvedValueOnce(null) // our initial check: nothing active yet
      .mockResolvedValueOnce(row({ id: 9 })); // after the race: the other request's session
    prisma.attendanceSession.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = mockRes();
    const next = vi.fn();
    await startSession(teacherAt(2), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].session.id).toBe(9);
    // Both lookups are for the same center.
    for (const [{ where }] of prisma.attendanceSession.findFirst.mock.calls) {
      expect(where).toEqual({ status: "active", centerId: 2 });
    }
  });

  it("does not swallow other database errors", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(null);
    const err = Object.assign(new Error("boom"), { code: "P1001" });
    prisma.attendanceSession.create.mockRejectedValue(err);
    const next = vi.fn();
    await startSession(teacherAt(2), mockRes(), next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe("sessions are per center", () => {
  it("a Teacher only looks for, and starts, a session at their OWN center", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(null);
    prisma.attendanceSession.create.mockResolvedValue(row());
    await startSession(teacherAt(2), mockRes(), vi.fn());
    expect(prisma.attendanceSession.findFirst.mock.calls[0][0].where).toEqual({ status: "active", centerId: 2 });
    expect(prisma.attendanceSession.create.mock.calls[0][0].data.centerId).toBe(2);
  });

  it("another center's running session does not count as 'already started'", async () => {
    // The lookup is filtered by center, so center 1's session is never returned for center 2.
    prisma.attendanceSession.findFirst.mockImplementation(async ({ where }) => (where.centerId === 1 ? row() : null));
    prisma.attendanceSession.create.mockResolvedValue(row({ id: 8 }));
    const res = mockRes();
    await startSession(teacherAt(2), res, vi.fn());
    expect(prisma.attendanceSession.create).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("Stop closes only the caller's center, never anyone else's", async () => {
    prisma.attendanceSession.updateMany.mockResolvedValue({ count: 1 });
    await stopSession(teacherAt(2), mockRes(), vi.fn());
    expect(prisma.attendanceSession.updateMany.mock.calls[0][0].where).toEqual({ status: "active", centerId: 2 });
  });

  it("a Teacher with no center yet only acts on the shared 'no center' session", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(null);
    prisma.attendanceSession.create.mockResolvedValue(row());
    await startSession(teacherReq, mockRes(), vi.fn());
    expect(prisma.attendanceSession.findFirst.mock.calls[0][0].where).toEqual({ status: "active", centerId: null });
    expect(prisma.attendanceSession.create.mock.calls[0][0].data.centerId).toBeNull();

    prisma.attendanceSession.updateMany.mockResolvedValue({ count: 0 });
    await stopSession(teacherReq, mockRes(), vi.fn());
    expect(prisma.attendanceSession.updateMany.mock.calls[0][0].where).toEqual({ status: "active", centerId: null });
  });

  it("a Teacher cannot name another center, in the body or the query", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(null);
    prisma.attendanceSession.create.mockResolvedValue(row());
    const hostile = { body: { centerId: 99 }, query: { centerId: "99" } };

    await startSession(teacherAt(2, hostile), mockRes(), vi.fn());
    await stopSession(teacherAt(2, hostile), mockRes(), vi.fn());
    await getCurrentSession(teacherAt(2, hostile), mockRes(), vi.fn());

    expect(prisma.attendanceSession.create.mock.calls[0][0].data.centerId).toBe(2);
    expect(prisma.attendanceSession.updateMany.mock.calls[0][0].where.centerId).toBe(2);
    for (const [{ where }] of prisma.attendanceSession.findFirst.mock.calls) expect(where.centerId).toBe(2);
  });

  describe("Admin (no center of their own)", () => {
    it("must name a center to start or stop, and nothing is touched without one", async () => {
      for (const [fn, body] of [
        [startSession, {}],
        [startSession, { centerId: "abc" }],
        [startSession, { centerId: -1 }],
        [startSession, { centerId: [1, 2] }],
        [startSession, { centerId: { a: 1 } }],
        [stopSession, {}],
        [stopSession, { centerId: "1e3" }],
      ]) {
        const next = vi.fn();
        await fn(adminReq({ body }), mockRes(), next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
      }
      expect(prisma.attendanceSession.findFirst).not.toHaveBeenCalled();
      expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
      expect(prisma.attendanceSession.updateMany).not.toHaveBeenCalled();
    });

    it("starts and stops the center they named", async () => {
      prisma.attendanceSession.findFirst.mockResolvedValue(null);
      prisma.attendanceSession.create.mockResolvedValue(row());
      await startSession(adminReq({ body: { centerId: 3 } }), mockRes(), vi.fn());
      expect(prisma.attendanceSession.create.mock.calls[0][0].data).toEqual({ date: TODAY, centerId: 3, startedById: 1 });

      prisma.attendanceSession.updateMany.mockResolvedValue({ count: 1 });
      await stopSession(adminReq({ body: { centerId: "3" } }), mockRes(), vi.fn());
      expect(prisma.attendanceSession.updateMany.mock.calls[0][0].where).toEqual({ status: "active", centerId: 3 });
    });

    it("gets a plain 404 when the center doesn't exist", async () => {
      prisma.attendanceSession.findFirst.mockResolvedValue(null);
      prisma.attendanceSession.create.mockRejectedValue(Object.assign(new Error("fk"), { code: "P2003" }));
      const next = vi.fn();
      await startSession(adminReq({ body: { centerId: 999 } }), mockRes(), next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404, message: "Center not found" }));
    });

    it("sees no session (and the database isn't read) until a center is named", async () => {
      const res = mockRes();
      await getCurrentSession(adminReq({ query: {} }), res, vi.fn());
      expect(res.json.mock.calls[0][0]).toMatchObject({ session: null, pickupChecks: [] });
      expect(prisma.attendanceSession.findFirst).not.toHaveBeenCalled();
    });

    it("reads the named center's session", async () => {
      prisma.attendanceSession.findFirst.mockResolvedValue(row());
      await getCurrentSession(adminReq({ query: { centerId: "3" } }), mockRes(), vi.fn());
      expect(prisma.attendanceSession.findFirst.mock.calls[0][0].where).toEqual({ status: "active", centerId: 3 });
    });
  });

  it("any other role is forbidden, before the database is touched", async () => {
    for (const fn of [startSession, stopSession, getCurrentSession]) {
      for (const user of [undefined, { id: 8, role: "Parent" }, { id: 8, role: "Guardian" }]) {
        const next = vi.fn();
        await fn({ user, body: {}, query: {} }, mockRes(), next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
      }
    }
    expect(prisma.attendanceSession.findFirst).not.toHaveBeenCalled();
    expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
    expect(prisma.attendanceSession.updateMany).not.toHaveBeenCalled();
  });
});

describe("stopSession", () => {
  it("closes the active session", async () => {
    prisma.attendanceSession.updateMany.mockResolvedValue({ count: 1 });
    const res = mockRes();
    await stopSession(teacherAt(2), res, vi.fn());

    const args = prisma.attendanceSession.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ status: "active", centerId: 2 });
    expect(args.data).toMatchObject({ status: "closed" });
    expect(args.data.endedAt).toBeInstanceOf(Date);
    expect(res.json).toHaveBeenCalledWith({ session: null });
  });

  it("is idempotent: stopping with nothing active still succeeds", async () => {
    prisma.attendanceSession.updateMany.mockResolvedValue({ count: 0 });
    const res = mockRes();
    const next = vi.fn();
    await stopSession(teacherAt(2), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ session: null });
  });
});
