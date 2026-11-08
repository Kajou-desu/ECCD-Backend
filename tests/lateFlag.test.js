import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    student: { findMany: vi.fn() },
    schoolTimeSettings: { findMany: vi.fn() },
    attendance: { findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { loadLateRules, lateFlag } = await import("../src/lib/lateFlag.js");
const { lateOf } = await import("../src/utils/late.js");
const { freezeLate } = await import("../src/services/lateBackfill.js");

// 8:20 AM and 1:20 PM Manila time on 2026-11-06.
const MORNING_820 = new Date("2026-11-06T00:20:00.000Z");
const AFTERNOON_120 = new Date("2026-11-06T05:20:00.000Z");
const times830 = { centerId: 4, morningStartMin: 510, morningEndMin: 660, afternoonStartMin: 780, afternoonEndMin: 900 };

beforeEach(() => {
  vi.resetAllMocks();
  prisma.schoolTimeSettings.findMany.mockResolvedValue([]);
});

describe("lateOf (reading a stored record)", () => {
  const rec = (over) => ({ status: "present", arrivedAt: MORNING_820, late: null, ...over });

  it("uses the stored answer whatever the session or times are now", () => {
    expect(lateOf(rec({ late: false }), "morning", undefined)).toBe(false); // 8:20 would be late today
    expect(lateOf(rec({ late: true, arrivedAt: new Date("2026-11-05T23:50:00Z") }), "morning", undefined)).toBe(true);
  });
  it("judges only a legacy record (null) live", () => {
    expect(lateOf(rec(), "morning", undefined)).toBe(true); // default 8:00 start
    expect(lateOf(rec(), "morning", times830)).toBe(false);
    expect(lateOf(rec({ status: "absent" }), "morning", undefined)).toBe(false);
  });
});

describe("loadLateRules / lateFlag (deciding at write time)", () => {
  it("asks nothing when there are no students", async () => {
    expect((await loadLateRules([])).size).toBe(0);
    expect(prisma.student.findMany).not.toHaveBeenCalled();
  });

  it("uses each student's own session and center times, in one student query", async () => {
    prisma.student.findMany.mockResolvedValue([
      { id: 1, session: "morning", teacher: { centerId: 4 } },
      { id: 2, session: "afternoon", teacher: { centerId: null } },
    ]);
    prisma.schoolTimeSettings.findMany.mockResolvedValue([times830]);
    const rules = await loadLateRules([1, 2, 2]);
    expect(prisma.student.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.student.findMany.mock.calls[0][0].where).toEqual({ id: { in: [1, 2] } });
    expect(lateFlag(rules, 1, "present", MORNING_820)).toBe(false); // center 4 starts 8:30
    expect(lateFlag(rules, 2, "present", AFTERNOON_120)).toBe(true); // default afternoon 1:00 PM start
    expect(lateFlag(rules, 2, "present", MORNING_820)).toBe(false); // earlier than 1:00 PM
  });

  it("is never null: not present, no arrival time, or an unknown student is simply not late", async () => {
    prisma.student.findMany.mockResolvedValue([{ id: 1, session: "morning", teacher: null }]);
    const rules = await loadLateRules([1]);
    expect(lateFlag(rules, 1, "absent", MORNING_820)).toBe(false);
    expect(lateFlag(rules, 1, "present", null)).toBe(false);
    expect(lateFlag(rules, 99, "present", MORNING_820)).toBe(false);
  });
});

describe("freezeLate", () => {
  const row = (id, arrivedAt, session = "morning", centerId = null, status = "present") => ({
    id, status, arrivedAt, student: { session, teacher: centerId === null ? null : { centerId } },
  });

  it("gives every record without an answer one, in batches, then stops", async () => {
    prisma.attendance.findMany
      .mockResolvedValueOnce([row(1, MORNING_820), row(2, new Date("2026-11-05T23:50:00Z")), row(3, null)])
      .mockResolvedValueOnce([]);
    prisma.attendance.updateMany.mockResolvedValue({ count: 1 });
    expect(await freezeLate()).toBe(3);
    expect(prisma.attendance.findMany.mock.calls[0][0].where).toEqual({ late: null });
    expect(prisma.attendance.updateMany).toHaveBeenCalledWith({ where: { id: { in: [1] } }, data: { late: true } });
    expect(prisma.attendance.updateMany).toHaveBeenCalledWith({ where: { id: { in: [2, 3] } }, data: { late: false } });
  });

  it("can be limited to one student and run inside a transaction", async () => {
    const tx = { attendance: { findMany: vi.fn().mockResolvedValueOnce([row(5, MORNING_820, "morning", 4)]).mockResolvedValueOnce([]), updateMany: vi.fn() } };
    prisma.schoolTimeSettings.findMany.mockResolvedValue([times830]);
    expect(await freezeLate({ where: { studentId: 9 }, db: tx })).toBe(1);
    expect(tx.attendance.findMany.mock.calls[0][0].where).toEqual({ studentId: 9, late: null });
    expect(tx.attendance.updateMany).toHaveBeenCalledWith({ where: { id: { in: [5] } }, data: { late: false } });
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
  });

  it("does nothing when nothing is unanswered", async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    expect(await freezeLate()).toBe(0);
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });
});
