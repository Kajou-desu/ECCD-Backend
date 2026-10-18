import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  prisma: {
    attendance: { findMany: vi.fn(), updateMany: vi.fn() },
    attendanceSession: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    attendanceSignal: { findMany: vi.fn() },
    pickupCheck: { findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
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
  runPickupWatch,
  resetPickupHealth,
  listOpenPickupChecks,
  answerPickupCheck,
  PROMPT_TTL_MS,
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
    const base = { lastFaceAt: at("02:40"), lastBleAt: at("02:41"), stillHereAt: undefined, arrivedAt: at("00:00"), windowStart: MORNING_START, unhealthyAt: at("02:00") };
    expect(absentSince(base)).toEqual(at("02:41"));
    expect(absentSince({ ...base, stillHereAt: at("02:45") })).toEqual(at("02:45"));
    expect(absentSince({ ...base, unhealthyAt: at("02:50") })).toEqual(at("02:50"));
    expect(absentSince({ ...base, lastFaceAt: undefined, lastBleAt: undefined, arrivedAt: at("02:44") })).toEqual(at("02:44"));
  });
});

describe("decidePickupAction", () => {
  const since = at("02:30");
  const decide = (now, lastCheck = null) => decidePickupAction({ now, absentSince: since, lastCheck, cfg: CFG });
  const check = (createdAt, over = {}) => ({ createdAt, expiresAt: new Date(createdAt.getTime() + PROMPT_TTL_MS), answeredAt: null, ...over });

  it("waits for the first minute", () => {
    expect(decide(at("02:30", 59))).toBe("wait");
  });
  it("prompts after one minute unseen", () => {
    expect(decide(at("02:31", 0))).toBe("prompt");
  });
  it("does not stack a second prompt while one is open", () => {
    expect(decide(at("02:31", 10), check(at("02:31", 0)))).toBe("wait");
  });
  it("prompts again a minute after the unanswered one expired", () => {
    const c = check(at("02:31", 0)); // expires 02:31:15
    expect(decide(at("02:32", 14), c)).toBe("wait");
    expect(decide(at("02:32", 15), c)).toBe("prompt");
  });
  it("marks picked up at 5 minutes with no answer", () => {
    expect(decide(at("02:35", 0), check(at("02:33", 30)))).toBe("pick_up");
  });
  it("still lets an open prompt finish before auto-marking at the 5 minute mark", () => {
    expect(decide(at("02:35", 5), check(at("02:35", 0)))).toBe("wait");
    expect(decide(at("02:35", 15), check(at("02:35", 0)))).toBe("pick_up");
  });
  it("ignores prompts from before the student was last seen", () => {
    const seenLater = decidePickupAction({ now: at("02:36", 0), absentSince: at("02:35", 0), lastCheck: check(at("02:31", 0)), cfg: CFG });
    expect(seenLater).toBe("prompt");
  });
});

// ---- runPickupWatch ---------------------------------------------------------

const record = (over = {}) => ({
  id: 100, studentId: 5, arrivedAt: at("00:00"), pickedUpAt: null, pickedUpAuto: false,
  student: { session: "morning" }, ...over,
});
const session = (over = {}) => ({ id: 1, date: TODAY, autoStarted: true, startedAt: at("02:30"), stopReminderSentAt: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  resetPickupHealth(at("02:00")); // healthy since before the window
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
  prisma.pickupCheck.findMany.mockResolvedValue([]);
  prisma.pickupCheck.create.mockResolvedValue({});
});

describe("runPickupWatch — when it acts", () => {
  it("does nothing outside a pickup window", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    await runPickupWatch(at("02:00")); // 10:00 Manila
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });

  it("only looks at present, arrived, unpicked students with an enabled tag, of the open session", async () => {
    await runPickupWatch(at("02:36"));
    const { where } = prisma.attendance.findMany.mock.calls[0][0];
    expect(where).toMatchObject({
      date: TODAY, status: "present", arrivedAt: { not: null },
      student: { status: "active", session: { in: ["morning"] }, bleDevices: { some: { enabled: true } } },
    });
  });

  it("marks a student picked up after 5 minutes of neither face nor tag, and notifies parents", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    const now = at("02:36"); // 6 min after the window opened, nobody seen
    await runPickupWatch(now);

    expect(prisma.attendance.updateMany).toHaveBeenCalledWith({
      where: { studentId: 5, date: TODAY, status: "present", arrivedAt: { not: null }, pickedUpAt: null },
      data: { pickedUpAt: now, pickedUpAuto: true },
    });
    await Promise.resolve();
    expect(notifyPickup).toHaveBeenCalledWith(5, now);
  });

  it("does not notify when someone else (a teacher) already marked the pickup", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    prisma.attendance.updateMany.mockResolvedValue({ count: 0 });
    await runPickupWatch(at("02:36"));
    await Promise.resolve();
    expect(notifyPickup).not.toHaveBeenCalled();
  });

  it("prompts the teacher after 1 minute and does not mark yet", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    const now = at("02:31", 5);
    await runPickupWatch(now);
    expect(prisma.pickupCheck.create).toHaveBeenCalledWith({
      data: { studentId: 5, date: TODAY, expiresAt: new Date(now.getTime() + 15_000) },
    });
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });

  it("does not prompt again while a prompt is still open", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    prisma.pickupCheck.findMany.mockResolvedValue([
      { studentId: 5, createdAt: at("02:31", 0), expiresAt: at("02:31", 15), answeredAt: null, answer: null },
    ]);
    await runPickupWatch(at("02:31", 10));
    expect(prisma.pickupCheck.create).not.toHaveBeenCalled();
  });

  it("leaves a student alone while either signal keeps seeing them", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    prisma.attendanceSignal.findMany.mockResolvedValue([
      { studentId: 5, kind: "ble", score: -60, hits: 9, lastSeenAt: at("02:35", 30) },
    ]);
    await runPickupWatch(at("02:36")); // BLE seen 30 s ago
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
    expect(prisma.pickupCheck.create).not.toHaveBeenCalled();
  });

  it("restarts the clock when the teacher says the student is still here", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    prisma.pickupCheck.findMany.mockResolvedValue([
      { studentId: 5, createdAt: at("02:34", 50), expiresAt: at("02:35", 5), answeredAt: at("02:35", 0), answer: "still_here" },
    ]);
    await runPickupWatch(at("02:36")); // 6 min since the window, but only 1 min since "still here"
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
    expect(prisma.pickupCheck.create).toHaveBeenCalledTimes(1); // the normal 1-minute prompt
  });

  it("counts a late arrival from when they arrived, not from the window start", async () => {
    prisma.attendance.findMany.mockResolvedValue([record({ arrivedAt: at("02:35", 30) })]);
    await runPickupWatch(at("02:36"));
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
    expect(prisma.pickupCheck.create).not.toHaveBeenCalled();
  });
});

describe("runPickupWatch — hardware must be alive", () => {
  it.each([
    ["the ESP32 gateway is offline", () => isGatewayOnline.mockResolvedValue(false)],
    ["the camera isn't sending frames", () => isCameraAlive.mockReturnValue(false)],
  ])("never prompts or marks anyone when %s", async (_name, breakIt) => {
    breakIt();
    prisma.attendance.findMany.mockResolvedValue([record()]);
    await runPickupWatch(at("02:40")); // 10 min of silence
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
    expect(prisma.pickupCheck.create).not.toHaveBeenCalled();
  });

  it("starts counting again only from when the hardware came back", async () => {
    prisma.attendance.findMany.mockResolvedValue([record()]);
    isCameraAlive.mockReturnValue(false);
    await runPickupWatch(at("02:40")); // outage noticed
    isCameraAlive.mockReturnValue(true);
    await runPickupWatch(at("02:40", 10)); // back: silence before this is ignored
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
    expect(prisma.pickupCheck.create).not.toHaveBeenCalled();
    await runPickupWatch(at("02:41", 15)); // a minute later it prompts as normal
    expect(prisma.pickupCheck.create).toHaveBeenCalledTimes(1);
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
    record({ student: { session: "morning", teacher: { centerId } }, ...over });
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
    expect(isCameraAlive).toHaveBeenCalledWith(1, expect.any(Date));
    expect(isCameraAlive).toHaveBeenCalledWith(2, expect.any(Date));
  });

  it("a center's outage restarts only that center's clock", async () => {
    prisma.attendanceSession.findMany.mockResolvedValue([sessionAt(1), sessionAt(2)]);
    prisma.attendance.findMany.mockResolvedValue([
      inCenter(1, { studentId: 5 }),
      inCenter(2, { studentId: 6, id: 101 }),
    ]);
    isCameraAlive.mockImplementation((centerId) => centerId === 1);
    await runPickupWatch(at("02:40")); // center 2 noticed down at 02:40
    prisma.attendance.updateMany.mockClear();

    isCameraAlive.mockReturnValue(true); // both cameras alive again
    await runPickupWatch(at("02:41")); // center 2 has only been back 1 min: not picked up yet
    expect(markedStudents()).toEqual([5]); // center 1 never had an outage, still judged from its own silence
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

describe("runPickupWatch — seen again", () => {
  const picked = (over = {}) => record({ pickedUpAt: at("02:36"), pickedUpAuto: true, ...over });
  const seen = (lastSeenAt) => [
    { studentId: 5, kind: "face", score: 0.3, hits: 5, lastSeenAt },
    { studentId: 5, kind: "ble", score: -55, hits: 5, lastSeenAt },
  ];

  beforeEach(() => {
    // Someone else is still unpicked, so the session stays open.
    prisma.attendance.findMany.mockResolvedValue([picked(), record({ id: 101, studentId: 6 })]);
  });

  it("puts an automatically picked-up student back when both signals see them again", async () => {
    prisma.attendanceSignal.findMany.mockResolvedValue(seen(at("02:39", 50)));
    await runPickupWatch(at("02:40"));
    expect(prisma.attendance.updateMany).toHaveBeenCalledWith({
      where: { id: 100, pickedUpAuto: true, pickedUpAt: { not: null } },
      data: { pickedUpAt: null, pickedUpAuto: false },
    });
  });

  it("needs BOTH signals, and both newer than the pickup", async () => {
    prisma.attendanceSignal.findMany.mockResolvedValue([seen(at("02:39", 50))[1]]); // tag only
    await runPickupWatch(at("02:40"));
    prisma.attendanceSignal.findMany.mockResolvedValue(seen(at("02:35", 0))); // before the pickup
    await runPickupWatch(at("02:40"));
    const undo = prisma.attendance.updateMany.mock.calls.filter(([a]) => a.data.pickedUpAt === null);
    expect(undo).toHaveLength(0);
  });

  it("never undoes a pickup a teacher made", async () => {
    prisma.attendance.findMany.mockResolvedValue([picked({ pickedUpAuto: false }), record({ id: 101, studentId: 6 })]);
    prisma.attendanceSignal.findMany.mockResolvedValue(seen(at("02:39", 50)));
    await runPickupWatch(at("02:40"));
    const undo = prisma.attendance.updateMany.mock.calls.filter(([a]) => a.data.pickedUpAt === null);
    expect(undo).toHaveLength(0);
  });

  it("leaves the pickup alone once the window is over", async () => {
    prisma.attendanceSignal.findMany.mockResolvedValue(seen(at("04:49", 50)));
    await runPickupWatch(at("04:50")); // 12:50 Manila, window closed at 12:30
    const undo = prisma.attendance.updateMany.mock.calls.filter(([a]) => a.data.pickedUpAt === null);
    expect(undo).toHaveLength(0);
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

describe("teacher prompts", () => {
  const NOW = at("02:31", 5);
  const teacher = { id: 3, role: "Teacher" };

  it("lists only the teacher's own students' open prompts, with time left", async () => {
    prisma.pickupCheck.findMany.mockResolvedValue([
      { id: 9, studentId: 5, expiresAt: at("02:31", 15), student: { name: "Ana Cruz" } },
    ]);
    const checks = await listOpenPickupChecks(teacher, NOW);
    expect(checks).toEqual([{ id: 9, studentId: 5, name: "Ana Cruz", expiresInMs: 10_000 }]);
    expect(prisma.pickupCheck.findMany.mock.calls[0][0].where).toMatchObject({
      date: TODAY, answeredAt: null, expiresAt: { gt: NOW }, student: { teacherId: 3 },
    });
  });

  describe("answerPickupCheck", () => {
    beforeEach(() => {
      prisma.pickupCheck.findUnique.mockResolvedValue({ id: 9, studentId: 5, date: TODAY });
      prisma.pickupCheck.updateMany.mockResolvedValue({ count: 1 });
      prisma.student.findUnique.mockResolvedValue({ teacherId: 3 });
    });

    it("'still here' records the answer and marks nobody", async () => {
      expect(await answerPickupCheck(teacher, 9, true, NOW)).toEqual({ outcome: "answered" });
      expect(prisma.pickupCheck.updateMany.mock.calls[0][0].data).toEqual({ answeredAt: NOW, answer: "still_here" });
      expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
    });

    it("'picked up' marks the student straight away as a manual (never undone) pickup and notifies parents", async () => {
      expect(await answerPickupCheck(teacher, 9, false, NOW)).toEqual({ outcome: "answered" });
      expect(prisma.attendance.updateMany.mock.calls[0][0].data).toEqual({ pickedUpAt: NOW, pickedUpAuto: false });
      await Promise.resolve();
      expect(notifyPickup).toHaveBeenCalledWith(5, NOW);
    });

    it("refuses an answer that arrives after the 15 seconds (or twice)", async () => {
      prisma.pickupCheck.updateMany.mockResolvedValue({ count: 0 });
      expect(await answerPickupCheck(teacher, 9, false, NOW)).toEqual({ outcome: "expired" });
      expect(prisma.pickupCheck.updateMany.mock.calls[0][0].where).toMatchObject({ answeredAt: null, expiresAt: { gt: NOW } });
      expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
    });

    it("cannot be answered by another teacher, and looks the same as a missing prompt", async () => {
      prisma.student.findUnique.mockResolvedValue({ teacherId: 99 });
      expect(await answerPickupCheck(teacher, 9, false, NOW)).toEqual({ outcome: "not_found" });
      expect(prisma.pickupCheck.updateMany).not.toHaveBeenCalled();
      expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
    });

    it("lets an Admin answer for any student", async () => {
      prisma.student.findUnique.mockResolvedValue({ teacherId: 99 });
      expect(await answerPickupCheck({ id: 1, role: "Admin" }, 9, true, NOW)).toEqual({ outcome: "answered" });
    });

    it("does not accept a prompt from another day", async () => {
      prisma.pickupCheck.findUnique.mockResolvedValue({ id: 9, studentId: 5, date: T("2026-10-09T00:00:00.000Z") });
      expect(await answerPickupCheck(teacher, 9, false, NOW)).toEqual({ outcome: "not_found" });
    });

    it("answers not_found for an unknown id", async () => {
      prisma.pickupCheck.findUnique.mockResolvedValue(null);
      expect(await answerPickupCheck(teacher, 404, false, NOW)).toEqual({ outcome: "not_found" });
    });
  });
});
