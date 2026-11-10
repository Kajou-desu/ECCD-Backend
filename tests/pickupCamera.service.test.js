import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  prisma: {
    attendance: { findMany: vi.fn(), updateMany: vi.fn() },
    attendanceSignal: { findUnique: vi.fn(), upsert: vi.fn() },
    pickupWatchOverride: { findFirst: vi.fn() },
    notification: { createMany: vi.fn() },
    student: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: db.prisma }));
vi.mock("../src/lib/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/services/attendanceNotification.service.js", () => ({
  notifyPickup: vi.fn().mockResolvedValue(undefined),
  notifyArrival: vi.fn(),
}));

const { prisma } = db;
const { notifyPickup } = await import("../src/services/attendanceNotification.service.js");
const { handleExitSighting, alertStudentsSeenAfterAutoPickup, alertIfSeenAfterAutoPickup } = await import(
  "../src/services/pickupCamera.service.js"
);

const T = (iso) => new Date(iso);
// School timezone is Asia/Manila (UTC+8). Monday 2026-10-12: the morning window is 10:30-12:30
// Manila (02:30Z-04:30Z), the afternoon one 14:30-16:30 (06:30Z-08:30Z).
const TODAY = T("2026-10-12T00:00:00.000Z");
const at = (hhmm, sec = 0) => T(`2026-10-12T${hhmm}:${String(sec).padStart(2, "0")}.000Z`);
const SESSION = { id: 3, date: TODAY, centerId: null };
const STUDENT = { id: 5, session: "morning", centerId: null };

// Stores one signal row in memory so consecutive sightings really accumulate hits.
let row;
beforeEach(() => {
  vi.clearAllMocks();
  row = null;
  prisma.attendanceSignal.findUnique.mockImplementation(async () => row);
  prisma.attendanceSignal.upsert.mockImplementation(async ({ create, update }) => {
    row = row ? { ...row, ...update } : { score: create.score, hits: create.hits, lastSeenAt: create.lastSeenAt };
  });
  prisma.pickupWatchOverride.findFirst.mockResolvedValue(null);
  prisma.attendance.updateMany.mockResolvedValue({ count: 1 });
  prisma.attendance.findMany.mockResolvedValue([]);
});

const see = (over = {}, now = at("02:40")) =>
  handleExitSighting({ session: SESSION, student: STUDENT, distance: 0.3, now, ...over });

describe("handleExitSighting", () => {
  it("needs two sightings in a row before marking anyone picked up", async () => {
    expect(await see({}, at("02:40", 0))).toEqual({ pickedUp: false });
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();

    expect(await see({}, at("02:40", 1))).toEqual({ pickedUp: true });
    expect(prisma.attendance.updateMany).toHaveBeenCalledWith({
      where: { studentId: 5, date: TODAY, status: "present", arrivedAt: { not: null }, pickedUpAt: null },
      data: { pickedUpAt: at("02:40", 1), pickedUpAuto: true, pickupReturnAlertedAt: null },
    });
    await Promise.resolve();
    expect(notifyPickup).toHaveBeenCalledWith(5, at("02:40", 1)); // parents are told right away
  });

  it("restarts the count when the sightings are too far apart (a stray match)", async () => {
    await see({}, at("02:40", 0));
    expect(await see({}, at("02:41", 0))).toEqual({ pickedUp: false }); // 60 s later: a new run
    expect(row.hits).toBe(1);
  });

  it("does not trust a loose match even when it is seen twice", async () => {
    await see({ distance: 0.8 }, at("02:40", 0));
    expect(await see({ distance: 0.8 }, at("02:40", 1))).toEqual({ pickedUp: false });
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });

  it("records the exit signal under its own kind, never as face or ble", async () => {
    await see();
    expect(prisma.attendanceSignal.upsert.mock.calls[0][0].create).toMatchObject({ sessionId: 3, studentId: 5, kind: "exit" });
  });

  describe("only while a pickup window covers the student", () => {
    it.each([
      ["before the window opens", at("02:00")], // 10:00 Manila
      ["after the window closes", at("04:30")], // 12:30 Manila
    ])("ignores a face %s, without any database write", async (_n, now) => {
      await see({}, now);
      expect(await see({}, new Date(now.getTime() + 1000))).toEqual({ pickedUp: false });
      expect(prisma.attendanceSignal.upsert).not.toHaveBeenCalled();
      expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
    });

    it("an afternoon student is not picked up in the morning window", async () => {
      const student = { ...STUDENT, session: "afternoon" };
      await see({ student }, at("02:40", 0));
      expect(await see({ student }, at("02:40", 1))).toEqual({ pickedUp: false });
      expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
    });

    it("a teacher's Stop pauses the scheduled window", async () => {
      prisma.pickupWatchOverride.findFirst.mockResolvedValue({ mode: "off", setAt: at("02:35") });
      await see({}, at("02:40", 0));
      expect(await see({}, at("02:40", 1))).toEqual({ pickedUp: false });
      expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
    });

    it("a teacher's Start opens a window of its own, for any student, at any hour", async () => {
      prisma.pickupWatchOverride.findFirst.mockResolvedValue({ mode: "on", setAt: at("00:00") });
      await see({}, at("00:10", 0));
      expect(await see({}, at("00:10", 1))).toEqual({ pickedUp: true });
    });

    it("reads a center's override once per frame, however many faces it holds", async () => {
      const overrides = new Map();
      await see({ overrides }, at("02:40", 0));
      await see({ overrides, student: { ...STUDENT, id: 6 } }, at("02:40", 0));
      expect(prisma.pickupWatchOverride.findFirst).toHaveBeenCalledTimes(1);
    });
  });

  it("does not notify parents when the student was not eligible (absent, not arrived or already picked up)", async () => {
    prisma.attendance.updateMany.mockResolvedValue({ count: 0 }); // the guarded write matched nothing
    await see({}, at("02:40", 0));
    expect(await see({}, at("02:40", 1))).toEqual({ pickedUp: false });
    await Promise.resolve();
    expect(notifyPickup).not.toHaveBeenCalled();
  });
});

describe("alertStudentsSeenAfterAutoPickup", () => {
  beforeEach(() => {
    prisma.student.findUnique.mockResolvedValue({ name: "Ana Reyes", teacherId: 7, teacher: { centerId: 2 } });
    prisma.user.findMany.mockResolvedValue([{ id: 7 }, { id: 8 }]);
    prisma.notification.createMany.mockResolvedValue({ count: 2 });
  });

  it("costs one read and nothing else when nobody was picked up", async () => {
    await alertStudentsSeenAfterAutoPickup([{ studentId: 5, date: TODAY }], at("02:50"));
    expect(prisma.attendance.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it("does nothing at all for an empty frame", async () => {
    await alertStudentsSeenAfterAutoPickup([], at("02:50"));
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
  });

  it("only looks at automatic pickups that have not been alerted about yet", async () => {
    await alertStudentsSeenAfterAutoPickup([{ studentId: 5, date: TODAY }], at("02:50"));
    expect(prisma.attendance.findMany.mock.calls[0][0].where).toMatchObject({
      studentId: { in: [5] }, pickedUpAuto: true, pickedUpAt: { not: null }, pickupReturnAlertedAt: null,
    });
  });

  it("tells the student's teacher and their colleagues in-app, once, and never undoes the pickup", async () => {
    prisma.attendance.findMany.mockResolvedValue([{ studentId: 5, date: TODAY }]);
    const now = at("02:50");
    await alertStudentsSeenAfterAutoPickup([{ studentId: 5, date: TODAY }], now);

    // The claim is a guarded write that only sets the alert timestamp: pickedUpAt is untouched.
    expect(prisma.attendance.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.attendance.updateMany).toHaveBeenCalledWith({
      where: { studentId: 5, date: TODAY, pickedUpAuto: true, pickedUpAt: { not: null }, pickupReturnAlertedAt: null },
      data: { pickupReturnAlertedAt: now },
    });
    const { data } = prisma.notification.createMany.mock.calls[0][0];
    expect(data.map((d) => d.userId).sort()).toEqual([7, 8]);
    expect(data[0].message).toContain("Ana Reyes");
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ role: "Teacher", centerId: 2, isActive: true });
  });

  it("another frame (or API instance) that lost the claim sends nothing", async () => {
    prisma.attendance.updateMany.mockResolvedValue({ count: 0 });
    expect(await alertIfSeenAfterAutoPickup(5, TODAY, at("02:50"))).toBe(false);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it("a notification failure is logged, not thrown", async () => {
    prisma.notification.createMany.mockRejectedValue(new Error("db down"));
    await expect(alertIfSeenAfterAutoPickup(5, TODAY, at("02:50"))).resolves.toBe(false);
  });
});
