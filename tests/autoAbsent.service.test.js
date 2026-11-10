import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => {
  const prisma = {
    noClassDay: { findUnique: vi.fn() },
    event: { findFirst: vi.fn() },
    center: { findMany: vi.fn() },
    schoolTimeSettings: { findMany: vi.fn() },
    autoAbsentRun: { findMany: vi.fn(), create: vi.fn() },
    student: { findMany: vi.fn() },
    attendance: { createMany: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
  return { prisma };
});
vi.mock("../src/lib/prisma.js", () => db);
vi.mock("../src/lib/logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

const { prisma } = db;
const { runAutoAbsent, isClassDay, CALENDAR_EVENT_CATEGORIES } = await import("../src/services/autoAbsent.service.js");

// School timezone is Asia/Manila (UTC+8). Defaults: morning ends 10:30, afternoon 14:30.
const MON_1031 = new Date("2026-11-09T02:31:00Z"); // Monday 10:31 in Manila
const MON_1029 = new Date("2026-11-09T02:29:00Z");
const MON_1431 = new Date("2026-11-09T06:31:00Z");
const SAT_1031 = new Date("2026-11-14T02:31:00Z");
const DATE = new Date("2026-11-09T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
  prisma.noClassDay.findUnique.mockResolvedValue(null);
  prisma.event.findFirst.mockResolvedValue(null);
  prisma.center.findMany.mockResolvedValue([{ id: 1 }]);
  prisma.schoolTimeSettings.findMany.mockResolvedValue([]);
  prisma.autoAbsentRun.findMany.mockResolvedValue([]);
  prisma.autoAbsentRun.create.mockResolvedValue({});
  prisma.student.findMany.mockResolvedValue([{ id: 10 }, { id: 11 }]);
  prisma.attendance.createMany.mockResolvedValue({ count: 2 });
});

const groupsMarked = () => prisma.autoAbsentRun.create.mock.calls.map(([{ data }]) => `${data.session}:${data.centerKey}`);

describe("runAutoAbsent", () => {
  it("marks unrecorded morning students absent once the morning session has ended, as not late", async () => {
    const result = await runAutoAbsent(MON_1031);
    expect(result.marked).toBe(4); // 2 students in each of the 2 groups
    expect(groupsMarked()).toEqual(["morning:1", "morning:0"]); // the center, then students with no center
    expect(prisma.attendance.createMany).toHaveBeenCalledWith({
      data: [
        { studentId: 10, date: DATE, status: "absent", late: false },
        { studentId: 11, date: DATE, status: "absent", late: false },
      ],
      skipDuplicates: true,
    });
  });

  it("only looks at active students of that session and center with no record that day", async () => {
    await runAutoAbsent(MON_1031);
    const where = prisma.student.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: "active", session: "morning", teacher: { centerId: 1 }, attendance: { none: { date: DATE } } });
    const noCenter = prisma.student.findMany.mock.calls[1][0].where;
    expect(noCenter.OR).toEqual([{ teacherId: null }, { teacher: { centerId: null } }]);
  });

  it("does nothing before the session ends", async () => {
    await runAutoAbsent(MON_1029);
    expect(prisma.student.findMany).not.toHaveBeenCalled();
    expect(prisma.attendance.createMany).not.toHaveBeenCalled();
  });

  it("handles the afternoon session at its own end time", async () => {
    prisma.autoAbsentRun.findMany.mockResolvedValue([{ session: "morning", centerKey: 1 }, { session: "morning", centerKey: 0 }]);
    await runAutoAbsent(MON_1431);
    expect(groupsMarked()).toEqual(["afternoon:1", "afternoon:0"]);
  });

  it("uses the center's own saved end time", async () => {
    prisma.schoolTimeSettings.findMany.mockResolvedValue([
      { centerId: 1, morningStartMin: 480, morningEndMin: 11 * 60, afternoonStartMin: 13 * 60, afternoonEndMin: 15 * 60 },
    ]);
    await runAutoAbsent(MON_1031); // 10:31 is before this center's 11:00 end
    expect(groupsMarked()).toEqual(["morning:0"]); // only the no-center group (defaults) is due
  });

  it("skips a group that was already done today", async () => {
    prisma.autoAbsentRun.findMany.mockResolvedValue([{ session: "morning", centerKey: 1 }, { session: "morning", centerKey: 0 }]);
    const result = await runAutoAbsent(MON_1031);
    expect(result.marked).toBe(0);
    expect(prisma.student.findMany).not.toHaveBeenCalled();
  });

  it("does not mark anyone twice when another run claims the group first", async () => {
    prisma.autoAbsentRun.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const result = await runAutoAbsent(MON_1031);
    expect(result.marked).toBe(0);
  });

  it("records a group with nobody to mark, so it isn't re-checked every minute", async () => {
    prisma.student.findMany.mockResolvedValue([]);
    await runAutoAbsent(MON_1031);
    expect(prisma.autoAbsentRun.create).toHaveBeenCalledTimes(2);
    expect(prisma.attendance.createMany).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected database error instead of swallowing it", async () => {
    prisma.autoAbsentRun.create.mockRejectedValue(new Error("db down"));
    await expect(runAutoAbsent(MON_1031)).rejects.toThrow("db down");
  });

  it.each([
    ["a weekend", SAT_1031, () => {}],
    ["a no-class day", MON_1031, () => prisma.noClassDay.findUnique.mockResolvedValue({ id: 1 })],
    ["a Holiday or Event on the calendar", MON_1031, () => prisma.event.findFirst.mockResolvedValue({ id: 5 })],
  ])("marks nobody absent on %s", async (_label, now, arrange) => {
    arrange();
    const result = await runAutoAbsent(now);
    expect(result.marked).toBe(0);
    expect(prisma.autoAbsentRun.create).not.toHaveBeenCalled();
    expect(prisma.attendance.createMany).not.toHaveBeenCalled();
  });
});

describe("isClassDay", () => {
  it("counts Holiday, Event and Others (shown as Event) but not Birthday", async () => {
    expect(CALENDAR_EVENT_CATEGORIES).toEqual(["Holiday", "Event", "Others"]);
    await isClassDay("2026-11-09");
    expect(prisma.event.findFirst.mock.calls[0][0].where).toEqual({ date: DATE, category: { in: ["Holiday", "Event", "Others"] } });
  });

  it("is true for an ordinary weekday and false for Sunday", async () => {
    expect(await isClassDay("2026-11-09")).toBe(true);
    expect(await isClassDay("2026-11-15")).toBe(false);
  });
});
