import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  prisma: {
    attendance: { findMany: vi.fn(), updateMany: vi.fn() },
    attendanceSession: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    attendanceSignal: { findMany: vi.fn() },
    pickupWatchOverride: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
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
vi.mock("../src/lib/hardwareStatus.js", () => ({
  isGatewayOnline: vi.fn(),
  isCameraAlive: vi.fn(),
}));

const { prisma } = db;
const { notifyPickup } = await import("../src/services/attendanceNotification.service.js");
const { isGatewayOnline, isCameraAlive } = await import("../src/lib/hardwareStatus.js");
const {
  pickupWindow,
  sessionsInWindow,
  absentSince,
  decidePickupAction,
  pickupWindowStatus,
  pickupWatchStatus,
  setPickupWatchRunning,
  runPickupWatch,
  presenceStatus,
  NOT_DETECTED_AFTER_MS,
} = await import("../src/services/pickupWatch.service.js");

const T = (iso) => new Date(iso);
// School timezone is Asia/Manila (UTC+8): 10:30 there is 02:30Z. Monday 2026-10-12.
const TODAY = T("2026-10-12T00:00:00.000Z");
const at = (hhmm, sec = 0) => T(`2026-10-12T${hhmm}:${String(sec).padStart(2, "0")}.000Z`);
const MORNING_START = at("02:30"); // 10:30 Manila
const CFG = { morningStartMin: 630, afternoonStartMin: 870, windowMs: 2 * 3600_000, absentMs: 5 * 60_000 };

describe("pickup window", () => {
  it("opens at the configured start and lasts the configured hours", () => {
    expect(pickupWindow("morning", CFG)).toEqual({ startMin: 630, endMin: 750 });
    expect(pickupWindow("afternoon", CFG)).toEqual({ startMin: 870, endMin: 990 });
  });

  it("knows which sessions are in their window (end exclusive)", () => {
    expect(sessionsInWindow(629, CFG)).toEqual([]);
    expect(sessionsInWindow(630, CFG)).toEqual(["morning"]);
    expect(sessionsInWindow(749, CFG)).toEqual(["morning"]);
    expect(sessionsInWindow(750, CFG)).toEqual([]);
    expect(sessionsInWindow(870, CFG)).toEqual(["afternoon"]);
  });

  it("reports the window for the monitor, including when it closes", () => {
    expect(pickupWindowStatus(at("02:00"), CFG)).toEqual({ active: false, endsAt: null });
    expect(pickupWindowStatus(at("03:00"), CFG)).toEqual({ active: true, endsAt: at("04:30") }); // 12:30 Manila
  });
});

describe("absentSince", () => {
  it("is the latest of every reason the clock could have restarted", () => {
    const base = { lastFaceAt: at("02:40"), lastBleAt: at("02:41"), arrivedAt: at("00:00"), windowStart: MORNING_START };
    expect(absentSince(base)).toEqual(at("02:41"));
    expect(absentSince({ ...base, unhealthyAt: at("02:50") })).toEqual(at("02:41")); // an outage is not a reason
    expect(absentSince({ ...base, lastFaceAt: undefined, lastBleAt: undefined, arrivedAt: at("02:44") })).toEqual(at("02:44"));
    expect(absentSince({ ...base, stillHereAt: at("02:46") })).toEqual(at("02:46"));
    expect(absentSince({ ...base, stillHereAt: at("02:30") })).toEqual(at("02:41")); // an old press changes nothing
    expect(absentSince({ ...base, stillHereAt: null })).toEqual(at("02:41"));
  });
});

describe("decidePickupAction", () => {
  const since = at("02:30");
  const decide = (now) => decidePickupAction({ now, absentSince: since, cfg: CFG });

  it("waits until 5 minutes have passed", () => {
    expect(decide(at("02:31", 0))).toBe("wait");
    expect(decide(at("02:34", 59))).toBe("wait");
  });
  it("marks picked up at 5 minutes unseen", () => {
    expect(decide(at("02:35", 0))).toBe("pick_up");
  });
  it("counts from the latest sighting, not from the first one", () => {
    expect(decidePickupAction({ now: at("02:36", 0), absentSince: at("02:35", 0), cfg: CFG })).toBe("wait");
  });
});

describe("presenceStatus", () => {
  const base = { now: at("02:40"), pickedUpAt: null, detectionActive: true, arrivedAt: at("02:00") };

  it("is Picked Up once a pickup is recorded, however long ago anything was seen", () => {
    expect(presenceStatus({ ...base, pickedUpAt: at("02:39") })).toBe("picked_up");
    expect(presenceStatus({ ...base, pickedUpAt: at("02:39"), detectionActive: false })).toBe("picked_up");
  });
  it("is Inside while either signal was seen within the last 3 minutes", () => {
    expect(presenceStatus({ ...base, lastFaceAt: at("02:37", 30) })).toBe("inside");
    expect(presenceStatus({ ...base, lastBleAt: at("02:37", 30) })).toBe("inside");
  });
  it("is Not Detected once neither signal has been seen for 3 minutes", () => {
    expect(NOT_DETECTED_AFTER_MS).toBe(180_000);
    expect(presenceStatus({ ...base, lastFaceAt: at("02:37", 0), lastBleAt: at("02:36", 0) })).toBe("not_detected");
    expect(presenceStatus({ ...base, lastFaceAt: at("02:37", 1) })).toBe("inside");
  });
  it("is Inside again for 3 minutes after a teacher presses Still here", () => {
    expect(presenceStatus({ ...base, stillHereAt: at("02:38", 0) })).toBe("inside");
    expect(presenceStatus({ ...base, stillHereAt: at("02:37", 0) })).toBe("not_detected");
  });
  it("counts from arrival when the student was never seen again", () => {
    expect(presenceStatus({ ...base, arrivedAt: at("02:37", 30) })).toBe("inside");
    expect(presenceStatus(base)).toBe("not_detected");
  });
  it("never says Not Detected while the camera or the tag reader is down", () => {
    expect(presenceStatus({ ...base, detectionActive: false })).toBe("inside");
  });
  it("does not restart the count after a hardware outage", () => {
    expect(presenceStatus({ ...base, unhealthyAt: at("02:38", 30) })).toBe("not_detected");
  });
});

// ---- runPickupWatch ---------------------------------------------------------

const record = (over = {}) => ({
  id: 100, studentId: 5, arrivedAt: at("00:00"), pickedUpAt: null, pickedUpAuto: false,
  student: { session: "morning", bleDevices: [{ id: 1 }] }, ...over,
});
const session = (over = {}) => ({ id: 1, date: TODAY, autoStarted: true, startedAt: at("02:30"), stopReminderSentAt: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  isGatewayOnline.mockResolvedValue(true);
  isCameraAlive.mockReturnValue(true);
  prisma.attendance.findMany.mockResolvedValue([]);
  prisma.attendance.updateMany.mockResolvedValue({ count: 1 });
  // The active sessions (one per center; these have no center). findFirst is only
  // used for "was one already stopped in this window?" and the lost-race lookup.
  prisma.attendanceSession.findMany.mockResolvedValue([session()]);
  prisma.attendanceSession.findFirst.mockResolvedValue(null);
  prisma.attendanceSession.updateMany.mockResolvedValue({ count: 1 });
  prisma.attendanceSignal.findMany.mockResolvedValue([]);
  prisma.pickupWatchOverride.findMany.mockResolvedValue([]);
  prisma.pickupWatchOverride.findFirst.mockResolvedValue(null);
  prisma.pickupWatchOverride.updateMany.mockResolvedValue({ count: 1 });
  prisma.pickupWatchOverride.create.mockResolvedValue({});
});

describe("runPickupWatch — when it acts", () => {
  it("does nothing outside a pickup window", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    await runPickupWatch(at("02:00")); // 10:00 Manila
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });

  it("looks at present, arrived students of the open session, tagged or not", async () => {
    await runPickupWatch(at("02:36"));
    const { where } = prisma.attendance.findMany.mock.calls[0][0];
    expect(where).toMatchObject({
      date: TODAY, status: "present", arrivedAt: { not: null },
      student: { status: "active", session: { in: ["morning"] } },
    });
    // An untagged student still keeps the session (and the exit camera) running.
    expect(where.student).not.toHaveProperty("bleDevices");
  });

  it("only judges students with an enabled tag by silence", async () => {
    prisma.attendance.findMany.mockResolvedValue([
      record({ studentId: 5 }),
      record({ id: 101, studentId: 6, student: { session: "morning", bleDevices: [] } }), // no tag
    ]);
    await runPickupWatch(at("02:36")); // 6 min of silence for both
    const marked = prisma.attendance.updateMany.mock.calls.map(([a]) => a.where.studentId);
    expect(marked).toEqual([5]);
  });

  it("keeps the pickup session running for a class with no tags at all", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([]);
    prisma.attendanceSession.create.mockResolvedValue(session());
    prisma.attendance.findMany.mockResolvedValue([record({ student: { session: "morning", bleDevices: [] } })]);
    await runPickupWatch(at("02:31"));
    expect(prisma.attendanceSession.create).toHaveBeenCalledTimes(1); // the exit camera needs a session
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });

  it("marks a student picked up after 5 minutes of neither face nor tag, and notifies parents", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    const now = at("02:36"); // 6 min after the window opened, nobody seen
    await runPickupWatch(now);

    expect(prisma.attendance.updateMany).toHaveBeenCalledWith({
      where: { studentId: 5, date: TODAY, status: "present", arrivedAt: { not: null }, pickedUpAt: null },
      data: { pickedUpAt: now, pickedUpAuto: true, pickupReturnAlertedAt: null },
    });
    await Promise.resolve();
    expect(notifyPickup).toHaveBeenCalledWith(5, now);
  });

  it("treats a single exit-camera sighting as proof the student was near the door, restarting the clock", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    prisma.attendanceSignal.findMany.mockResolvedValue([
      { studentId: 5, kind: "exit", score: 0.3, hits: 1, lastSeenAt: at("02:35", 30) },
    ]);
    await runPickupWatch(at("02:36")); // the exit camera saw them 30 s ago
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });

  it("does not notify when someone else (a teacher) already marked the pickup", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    prisma.attendance.updateMany.mockResolvedValue({ count: 0 });
    await runPickupWatch(at("02:36"));
    await Promise.resolve();
    expect(notifyPickup).not.toHaveBeenCalled();
  });

  it("does nothing before the 5 minutes are up", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    await runPickupWatch(at("02:31", 5));
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });

  it("leaves a student alone while either signal keeps seeing them", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    prisma.attendanceSignal.findMany.mockResolvedValue([
      { studentId: 5, kind: "ble", score: -60, hits: 9, lastSeenAt: at("02:35", 30) },
    ]);
    await runPickupWatch(at("02:36")); // BLE seen 30 s ago
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });

  it("counts a late arrival from when they arrived, not from the window start", async () => {
    prisma.attendance.findMany.mockResolvedValue([record({ arrivedAt: at("02:35", 30) })]);
    await runPickupWatch(at("02:36"));
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });
});

describe("runPickupWatch — hardware must be alive", () => {
  it.each([
    ["the ESP32 gateway is offline", () => isGatewayOnline.mockResolvedValue(false)],
    ["the exit camera isn't sending frames", () => isCameraAlive.mockReturnValue(false)],
  ])("never marks anyone when %s", async (_name, breakIt) => {
    breakIt();
    prisma.attendance.findMany.mockResolvedValue([record()]);
    await runPickupWatch(at("02:40")); // 10 min of silence
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });

  it("vouches for silence only through the EXIT camera, not the entry one", async () => {
    // The entry camera is up but the exit camera is down: a child could have walked out unseen.
    isCameraAlive.mockImplementation((_center, _now, role) => role === "entry");
    prisma.attendance.findMany.mockResolvedValue([record()]);
    await runPickupWatch(at("02:40"));
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
    expect(isCameraAlive).toHaveBeenCalledWith(null, expect.any(Date), "exit");
  });

  it("does not restart the 5-minute clock when the hardware comes back", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    prisma.attendanceSignal.findMany.mockResolvedValue([
      { studentId: 5, kind: "ble", score: -60, hits: 3, lastSeenAt: at("02:35") },
    ]);
    isCameraAlive.mockReturnValue(false);
    await runPickupWatch(at("02:38")); // outage: nobody is marked, and nothing is reset
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
    isCameraAlive.mockReturnValue(true);
    await runPickupWatch(at("02:40", 10)); // back: 5 min 10 s since the last sighting
    expect(prisma.attendance.updateMany).toHaveBeenCalledTimes(1);
  });

  it("still waits out the full 5 minutes when the outage began before that", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    prisma.attendanceSignal.findMany.mockResolvedValue([
      { studentId: 5, kind: "ble", score: -60, hits: 3, lastSeenAt: at("02:38") },
    ]);
    isCameraAlive.mockReturnValue(false);
    await runPickupWatch(at("02:39"));
    isCameraAlive.mockReturnValue(true);
    await runPickupWatch(at("02:41")); // only 3 min since the last sighting
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });
});

describe("runPickupWatch — the session", () => {
  it("starts a session by itself so the ESP32 scans and the camera can send", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([]); // no active session
    prisma.attendanceSession.findFirst.mockResolvedValue(null); // none stopped earlier in the window
    prisma.attendanceSession.create.mockResolvedValue(session());
    prisma.attendance.findMany.mockResolvedValue([record()]);
    await runPickupWatch(at("02:31"));
    expect(prisma.attendanceSession.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { date: TODAY, centerId: null, startedById: null, autoStarted: true } }),
    );
  });

  it("does not restart a pickup session that was stopped during this window", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([]); // none active
    prisma.attendanceSession.findFirst.mockResolvedValue({ id: 1 }); // one closed since the window opened
    prisma.attendance.findMany.mockResolvedValue([record()]);
    await runPickupWatch(at("02:40"));
    const stoppedQuery = prisma.attendanceSession.findFirst.mock.calls[0][0].where;
    expect(stoppedQuery).toMatchObject({
      date: TODAY, centerId: null, autoStarted: true, status: "closed", endedAt: { gte: MORNING_START },
    });
    expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled(); // and with no session nothing is judged
  });

  it("does not start a session when nobody is left to watch", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([]);
    prisma.attendance.findMany.mockResolvedValue([]);
    await runPickupWatch(at("02:40"));
    expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
  });

  it("closes a session it started once everyone has been picked up", async () => {
    prisma.attendance.findMany.mockResolvedValue([record({ pickedUpAt: at("02:36"), pickedUpAuto: true })]);
    await runPickupWatch(at("02:37"));
    expect(prisma.attendanceSession.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: "active" },
      data: { status: "closed", endedAt: at("02:37") },
    });
  });

  it("leaves a teacher-started session running", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([session({ autoStarted: false })]);
    prisma.attendance.findMany.mockResolvedValue([]);
    await runPickupWatch(at("02:37"));
    expect(prisma.attendanceSession.updateMany).not.toHaveBeenCalled();
  });

  it("closes a session left over from a previous day before starting a new one", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([session({ date: T("2026-10-11T00:00:00.000Z") })]);
    prisma.attendanceSession.findFirst.mockResolvedValue(null);
    prisma.attendanceSession.create.mockResolvedValue(session());
    prisma.attendance.findMany.mockResolvedValue([record()]);
    await runPickupWatch(at("02:31"));
    expect(prisma.attendanceSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1, status: "active" } }),
    );
    expect(prisma.attendanceSession.create).toHaveBeenCalled();
  });
});

describe("runPickupWatch — every center on its own", () => {
  const inCenter = (centerId, over = {}) =>
    record({ student: { session: "morning", bleDevices: [{ id: 1 }], teacher: { centerId } }, ...over });
  const sessionAt = (centerId, over = {}) => session({ id: 10 + centerId, centerId, ...over });
  const markedStudents = () => prisma.attendance.updateMany.mock.calls.map(([a]) => a.where.studentId);

  it("one center's dead camera pauses only that center, never another's", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([sessionAt(1), sessionAt(2)]);
    prisma.attendance.findMany.mockResolvedValue([
      inCenter(1, { studentId: 5 }),
      inCenter(2, { studentId: 6, id: 101 }),
    ]);
    isCameraAlive.mockImplementation((centerId) => centerId === 1); // only center 1's camera is streaming
    await runPickupWatch(at("02:40")); // 10 min of silence for both

    expect(markedStudents()).toEqual([5]); // center 1 judged; center 2's silence means nothing
    // Each center's EXIT camera is the one that vouches for its silence.
    expect(isCameraAlive).toHaveBeenCalledWith(1, expect.any(Date), "exit");
    expect(isCameraAlive).toHaveBeenCalledWith(2, expect.any(Date), "exit");
  });

  it("a center's outage does not restart that center's clock either", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([sessionAt(1), sessionAt(2)]);
    prisma.attendance.findMany.mockResolvedValue([
      inCenter(1, { studentId: 5 }),
      inCenter(2, { studentId: 6, id: 101 }),
    ]);
    isCameraAlive.mockImplementation((centerId) => centerId === 1);
    await runPickupWatch(at("02:40")); // center 2 noticed down at 02:40
    prisma.attendance.updateMany.mockClear();

    isCameraAlive.mockReturnValue(true); // both cameras alive again
    await runPickupWatch(at("02:41")); // center 2 is back, and its silence since 02:30 already exceeds 5 min
    expect(markedStudents()).toEqual([5, 6]); // both are past 5 min of silence; the mock doesn't persist center 1's earlier mark
  });

  it("starts a session only for the center that has someone left to watch", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([]);
    prisma.attendance.findMany.mockResolvedValue([inCenter(2, { studentId: 6 })]);
    prisma.attendanceSession.create.mockResolvedValue(sessionAt(2));
    await runPickupWatch(at("02:31"));

    expect(prisma.attendanceSession.create).toHaveBeenCalledTimes(1);
    expect(prisma.attendanceSession.create.mock.calls[0][0].data).toEqual({
      date: TODAY, centerId: 2, startedById: null, autoStarted: true,
    });
  });

  it("looks for a stopped pickup session at the same center only", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([]);
    prisma.attendance.findMany.mockResolvedValue([inCenter(2, { studentId: 6 })]);
    prisma.attendanceSession.findFirst.mockResolvedValue({ id: 1 }); // center 2's was stopped
    await runPickupWatch(at("02:40"));
    expect(prisma.attendanceSession.findFirst.mock.calls[0][0].where).toMatchObject({ centerId: 2 });
    expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
  });

  it("closes a center's own auto-started session once ITS students are all picked up, leaving others running", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([sessionAt(1), sessionAt(2)]);
    prisma.attendance.findMany.mockResolvedValue([
      inCenter(1, { studentId: 5, pickedUpAt: at("02:36"), pickedUpAuto: true }), // center 1: everyone gone
      inCenter(2, { studentId: 6, id: 101 }), // center 2: still someone to watch
    ]);
    await runPickupWatch(at("02:37"));

    const closed = prisma.attendanceSession.updateMany.mock.calls.filter(([a]) => a.data.status === "closed");
    expect(closed.map(([a]) => a.where.id)).toEqual([11]); // only center 1's session
  });

  it("closes a center's session even when its last record has gone from the list", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([sessionAt(1)]);
    prisma.attendance.findMany.mockResolvedValue([]); // nobody at all to watch
    await runPickupWatch(at("02:37"));
    expect(prisma.attendanceSession.updateMany).toHaveBeenCalledWith({
      where: { id: 11, status: "active" },
      data: { status: "closed", endedAt: at("02:37") },
    });
  });

  it("an error at one center does not stop the others being watched", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([sessionAt(1), sessionAt(2)]);
    prisma.attendance.findMany.mockResolvedValue([
      inCenter(1, { studentId: 5 }),
      inCenter(2, { studentId: 6, id: 101 }),
    ]);
    isGatewayOnline.mockRejectedValueOnce(new Error("db blip")); // center 1's turn fails
    await runPickupWatch(at("02:40"));
    expect(markedStudents()).toEqual([6]); // center 2 still handled
  });

  it("the stop reminder only goes to the session's own center", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([sessionAt(1)]);
    prisma.attendance.findMany.mockResolvedValue([{ student: { teacherId: 3, teacher: { centerId: 1 } } }]);
    prisma.user.findMany.mockResolvedValue([{ id: 3 }]);
    await runPickupWatch(at("04:40"));
    expect(prisma.attendance.findMany.mock.calls[0][0].where.student).toMatchObject({ teacher: { centerId: 1 } });
  });
});

describe("runPickupWatch — an automatic pickup is never undone", () => {
  const picked = (over = {}) => record({ pickedUpAt: at("02:36"), pickedUpAuto: true, ...over });
  const seen = (lastSeenAt) => [
    { studentId: 5, kind: "face", score: 0.3, hits: 5, lastSeenAt },
    { studentId: 5, kind: "ble", score: -55, hits: 5, lastSeenAt },
  ];

  it("leaves an automatic pickup in place even when both signals see the student again", async () => {
    // Someone else is still unpicked, so the session stays open and signals are read.
    prisma.attendance.findMany.mockResolvedValue([picked(), record({ id: 101, studentId: 6 })]);
    prisma.attendanceSignal.findMany.mockResolvedValue(seen(at("02:39", 50)));
    await runPickupWatch(at("02:40"));
    const undo = prisma.attendance.updateMany.mock.calls.filter(([a]) => a.data.pickedUpAt === null);
    expect(undo).toHaveLength(0); // the entry camera alerts the teachers instead (pickupCamera.service)
  });

  it("does not judge an already picked-up student by silence", async () => {
    prisma.attendance.findMany.mockResolvedValue([picked()]);
    await runPickupWatch(at("02:50"));
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });
});

describe("runPickupWatch — stop reminder", () => {
  const afterWindow = at("04:40"); // 12:40 Manila; morning window closed at 12:30

  it("tells each affected teacher once, in-app, to stop the camera", async () => {
    prisma.attendance.findMany.mockResolvedValue([
      { student: { teacherId: 3 } }, { student: { teacherId: 3 } }, { student: { teacherId: 4 } },
    ]);
    await runPickupWatch(afterWindow);
    const { data } = prisma.notification.createMany.mock.calls[0][0];
    expect(data.map((d) => d.userId).sort()).toEqual([3, 4]);
    expect(prisma.attendanceSession.updateMany).toHaveBeenCalledWith({
      where: { id: 1, stopReminderSentAt: null },
      data: { stopReminderSentAt: afterWindow },
    });
  });

  it("also reaches the other teachers at the affected students' center", async () => {
    prisma.attendance.findMany.mockResolvedValue([
      { student: { teacherId: 3, teacher: { centerId: 2 } } },
      { student: { teacherId: 4, teacher: { centerId: 2 } } },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 3 }, { id: 4 }, { id: 5 }]);
    await runPickupWatch(afterWindow);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { role: "Teacher", centerId: { in: [2] }, isActive: true },
      select: { id: true },
    });
    const { data } = prisma.notification.createMany.mock.calls[0][0];
    expect(data.map((d) => d.userId).sort()).toEqual([3, 4, 5]);
  });

  it("does not repeat itself", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([session({ stopReminderSentAt: at("04:31") })]);
    await runPickupWatch(afterWindow);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it("loses gracefully if another run already claimed it", async () => {
    prisma.attendanceSession.updateMany.mockResolvedValue({ count: 0 });
    await runPickupWatch(afterWindow);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it("ignores a session that only started after the window closed", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([session({ startedAt: at("04:35") })]);
    await runPickupWatch(afterWindow);
    expect(prisma.attendanceSession.updateMany).not.toHaveBeenCalled();
  });

  it("does not remind hours later (e.g. after a restart)", async () => {
    await runPickupWatch(at("06:00")); // 14:00 Manila: an hour and a half after the morning window, before the afternoon one
    expect(prisma.attendanceSession.updateMany).not.toHaveBeenCalled();
  });
});

// ---- the teacher's manual Start / Stop ---------------------------------------

describe("manual Start / Stop", () => {
  const off = (setAt) => ({ mode: "off", setAt });
  const on = (setAt) => ({ mode: "on", setAt });
  const centerRecord = (centerId, over = {}) => record({ student: { session: "morning", bleDevices: [{ id: 1 }], teacher: { centerId } }, ...over });
  const markedStudents = () => prisma.attendance.updateMany.mock.calls.map(([a]) => a.where.studentId);

  describe("pickupWatchStatus", () => {
    it("follows the schedule with no override", () => {
      expect(pickupWatchStatus(at("03:00"), null, CFG)).toEqual({ active: true, endsAt: at("04:30"), mode: "auto" });
      expect(pickupWatchStatus(at("02:00"), null, CFG)).toEqual({ active: false, endsAt: null, mode: "auto" });
    });
    it("Stop pauses the window that was open, but not one that opens later", () => {
      const stopped = off(at("03:00"));
      expect(pickupWatchStatus(at("03:30"), stopped, CFG)).toEqual({ active: false, endsAt: null, mode: "off" });
      expect(pickupWatchStatus(at("06:30"), stopped, CFG)).toEqual({ active: true, endsAt: at("08:30"), mode: "auto" }); // 14:30 Manila
    });
    it("Start opens a window of its own, even outside the schedule, for the configured hours", () => {
      const started = on(at("00:00")); // 08:00 Manila
      expect(pickupWatchStatus(at("01:00"), started, CFG)).toEqual({ active: true, endsAt: at("02:00"), mode: "on" });
      expect(pickupWatchStatus(at("02:00"), started, CFG).active).toBe(false); // over
    });
    it("Start after a Stop resumes, and runs to whichever end is later", () => {
      expect(pickupWatchStatus(at("04:00"), on(at("04:00")), CFG)).toEqual({ active: true, endsAt: at("06:00"), mode: "on" });
    });
  });

  describe("setPickupWatchRunning", () => {
    it("Start writes an 'on' row when tracking is not running", async () => {
      const status = await setPickupWatchRunning(4, true, at("00:00"));
      expect(prisma.pickupWatchOverride.create).toHaveBeenCalledWith({
        data: { date: TODAY, centerId: 4, mode: "on", setAt: at("00:00") },
      });
      expect(status).toBeDefined();
    });
    it("Start is a no-op while the schedule already runs (it must not restart anyone's clock)", async () => {
      const status = await setPickupWatchRunning(null, true, at("03:00"));
      expect(prisma.pickupWatchOverride.create).not.toHaveBeenCalled();
      expect(prisma.pickupWatchOverride.updateMany).not.toHaveBeenCalled();
      expect(status).toEqual({ active: true, endsAt: at("04:30"), mode: "auto" });
    });
    it("Stop updates the existing row in place", async () => {
      prisma.pickupWatchOverride.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 3 });
      await setPickupWatchRunning(null, false, at("03:00"));
      expect(prisma.pickupWatchOverride.updateMany).toHaveBeenCalledWith({
        where: { id: 3 }, data: { mode: "off", setAt: at("03:00") },
      });
    });
    it("Stop is a no-op when nothing is running", async () => {
      await setPickupWatchRunning(null, false, at("02:00"));
      expect(prisma.pickupWatchOverride.create).not.toHaveBeenCalled();
      expect(prisma.pickupWatchOverride.updateMany).not.toHaveBeenCalled();
    });
    it("a lost race on the one-row-per-day index updates the winner's row", async () => {
      prisma.pickupWatchOverride.create.mockRejectedValue({ code: "P2002" });
      await setPickupWatchRunning(4, true, at("00:00"));
      expect(prisma.pickupWatchOverride.updateMany).toHaveBeenCalledWith({
        where: { date: TODAY, centerId: 4 }, data: { mode: "on", setAt: at("00:00") },
      });
    });
    it("other errors are not swallowed", async () => {
      prisma.pickupWatchOverride.create.mockRejectedValue({ code: "P2003" });
      await expect(setPickupWatchRunning(999, true, at("00:00"))).rejects.toMatchObject({ code: "P2003" });
    });
  });

  describe("runPickupWatch", () => {
    it("a stopped center is left alone: no pickup, and its session stays open", async () => {
      prisma.attendance.findMany.mockResolvedValue([centerRecord(1)]);
      prisma.attendanceSession.findMany.mockResolvedValue([session({ centerId: 1 })]);
      prisma.pickupWatchOverride.findMany.mockResolvedValue([{ centerId: 1, ...off(at("02:31")) }]);
      await runPickupWatch(at("02:40")); // 10 min of silence
      expect(markedStudents()).toEqual([]);
        expect(prisma.attendanceSession.updateMany).not.toHaveBeenCalled(); // not closed, not restarted
      expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
    });

    it("stopping one center does not stop another", async () => {
      prisma.attendance.findMany.mockResolvedValue([centerRecord(1), centerRecord(2, { studentId: 6, id: 101 })]);
      prisma.attendanceSession.findMany.mockResolvedValue([session({ id: 11, centerId: 1 }), session({ id: 12, centerId: 2 })]);
      prisma.pickupWatchOverride.findMany.mockResolvedValue([{ centerId: 1, ...off(at("02:31")) }]);
      await runPickupWatch(at("02:40"));
      expect(markedStudents()).toEqual([6]);
    });

    it("a Stop from the morning window does not stop the afternoon one", async () => {
      prisma.attendance.findMany.mockResolvedValue([centerRecord(null, { student: { session: "afternoon", bleDevices: [{ id: 1 }], teacher: { centerId: null } } })]);
      prisma.attendanceSession.findMany.mockResolvedValue([session({ centerId: null })]);
      prisma.pickupWatchOverride.findMany.mockResolvedValue([{ centerId: null, ...off(at("03:00")) }]);
      await runPickupWatch(at("06:40")); // 14:40 Manila, ten minutes into the afternoon window
      expect(markedStudents()).toEqual([5]);
    });

    it("Start tracks every student outside the schedule, counting silence only from the press", async () => {
      const startedAt = at("00:00"); // 08:00 Manila, no scheduled window
      prisma.attendance.findMany.mockResolvedValue([centerRecord(null, { arrivedAt: at("00:00") })]);
      prisma.attendanceSession.findMany.mockResolvedValue([session({ centerId: null, startedAt })]);
      prisma.pickupWatchOverride.findMany.mockResolvedValue([{ centerId: null, ...on(startedAt) }]);

      await runPickupWatch(at("00:04")); // 4 min after Start: too early to mark
      expect(markedStudents()).toEqual([]);
      const { where } = prisma.attendance.findMany.mock.calls[0][0];
      expect(where.student.session).toEqual({ in: ["morning", "afternoon"] });

      await runPickupWatch(at("00:06")); // past the 5-minute mark
      expect(markedStudents()).toEqual([5]);
    });

    it("Start does not reach back over a pause: nobody is marked for the minutes it was stopped", async () => {
      // last seen 02:35; stopped 02:36; started again 02:50 -> silence counts from 02:50, not 02:35
      prisma.attendance.findMany.mockResolvedValue([centerRecord(null)]);
      prisma.attendanceSignal.findMany.mockResolvedValue([
        { studentId: 5, kind: "face", score: 0.9, hits: 3, lastSeenAt: at("02:35") },
      ]);
      prisma.pickupWatchOverride.findMany.mockResolvedValue([{ centerId: null, ...on(at("02:50")) }]);
      await runPickupWatch(at("02:52"));
      expect(markedStudents()).toEqual([]);
    });

    it("a manual window that has run its course stops tracking", async () => {
      prisma.attendance.findMany.mockResolvedValue([centerRecord(null)]);
      prisma.pickupWatchOverride.findMany.mockResolvedValue([{ centerId: null, ...on(at("00:00")) }]);
      await runPickupWatch(at("02:01")); // 2 h + 1 min later, outside the schedule too
      expect(prisma.attendance.findMany).not.toHaveBeenCalled();
    });
  });
});
