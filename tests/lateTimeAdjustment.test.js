import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Phase 4 check: changing a center's school times changes who is Late — on the
// daily cards, the range export and the dashboard — with no other change. The
// database is replaced by a tiny in-memory store so the real controllers run
// end to end (the settings controller writes, the others read what it wrote).

const store = vi.hoisted(() => ({ settings: new Map() }));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    center: { findUnique: vi.fn(async ({ where }) => ({ id: where.id })) },
    schoolTimeSettings: {
      upsert: vi.fn(async ({ where, create, update }) => {
        const next = { id: 1, ...(store.settings.get(where.centerId) ?? create), ...(store.settings.has(where.centerId) ? update : {}) };
        store.settings.set(where.centerId, { centerId: where.centerId, ...next });
        return store.settings.get(where.centerId);
      }),
      findUnique: vi.fn(async ({ where }) => store.settings.get(where.centerId) ?? null),
      findMany: vi.fn(async ({ where }) => [...store.settings.values()].filter((r) => where.centerId.in.includes(r.centerId))),
    },
    student: { findMany: vi.fn(), count: vi.fn() },
    attendance: { findMany: vi.fn(), count: vi.fn() },
    material: { count: vi.fn() },
  },
}));
vi.mock("../src/lib/signedFileUrl.js", () => ({ signFileUrl: vi.fn(() => null) }));

const { prisma } = await import("../src/lib/prisma.js");
const { updateSchoolTimes } = await import("../src/controllers/schoolTimes.controller.js");
const { getAttendance } = await import("../src/controllers/attendance.controller.js");
const { getAttendanceRange } = await import("../src/controllers/attendanceBulk.controller.js");
const { getDashboardStats } = await import("../src/controllers/dashboard.controller.js");

const teacher = { id: 5, role: "Teacher", centerId: 8 };
const otherTeacher = { id: 6, role: "Teacher", centerId: 9 };
// Friday 2026-11-06, 08:20 AM in Manila (UTC+8).
const ARRIVED = new Date("2026-11-06T00:20:00.000Z");
const DAY = new Date("2026-11-06T00:00:00.000Z");

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  return res;
}
async function call(fn, req) {
  const res = mockRes();
  const next = vi.fn();
  await fn({ query: {}, body: {}, params: {}, ...req }, res, next);
  if (next.mock.calls.length) throw next.mock.calls[0][0];
  return res.json.mock.calls[0][0];
}
const setTimes = (user, morningStart) =>
  call(updateSchoolTimes, { user, body: { morningStart, morningEnd: "11:00", afternoonStart: "13:00", afternoonEnd: "15:00" } });

const lateOnCard = async (user) =>
  (await call(getAttendance, { user, query: { date: "2026-11-06" } }))[0].late;
const lateInExport = async (user) =>
  (await call(getAttendanceRange, { user, query: { from: "2026-11-06", to: "2026-11-06" } })).records[0].late;
const lateOnDashboard = async (user) => (await call(getDashboardStats, { user })).lateToday;

beforeEach(() => {
  store.settings.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T04:00:00.000Z")); // noon in Manila
  prisma.student.findMany.mockResolvedValue([{ id: 1, name: "Ana Cruz", session: "morning", photo: null, teacher: { centerId: 8 } }]);
  prisma.student.count.mockResolvedValue(1);
  const record = { studentId: 1, date: DAY, status: "present", arrivedAt: ARRIVED, pickedUpAt: null, verification: null };
  prisma.attendance.findMany.mockImplementation(async (args) =>
    args.select?.student
      ? [{ ...record, student: { name: "Ana Cruz", studentCode: "C1", session: "morning", teacher: { centerId: 8 } }, arrivedAt: ARRIVED }]
      : [record],
  );
  prisma.attendance.count.mockResolvedValue(0);
  prisma.material.count.mockResolvedValue(0);
});
afterEach(() => vi.useRealTimers());

describe("adjusting a center's school times", () => {
  it("with no saved times, an 8:20 arrival is late everywhere (default 8:00 start)", async () => {
    expect(await lateOnCard(teacher)).toBe(true);
    expect(await lateInExport(teacher)).toBe(true);
    expect(await lateOnDashboard(teacher)).toBe(1);
  });

  it("moving the morning start to 8:30 makes the same arrival on time on the cards, the export and the dashboard", async () => {
    await setTimes(teacher, "08:30");
    expect(await lateOnCard(teacher)).toBe(false);
    expect(await lateInExport(teacher)).toBe(false);
    expect(await lateOnDashboard(teacher)).toBe(0);
  });

  it("moving it back to 8:00 makes the arrival late again", async () => {
    await setTimes(teacher, "08:30");
    await setTimes(teacher, "08:00");
    expect(await lateOnCard(teacher)).toBe(true);
    expect(await lateOnDashboard(teacher)).toBe(1);
  });

  it("arriving exactly at the start is on time; one minute after is late", async () => {
    await setTimes(teacher, "08:20");
    expect(await lateOnCard(teacher)).toBe(false);
    await setTimes(teacher, "08:19");
    expect(await lateOnCard(teacher)).toBe(true);
  });

  it("another center's saved times never change this center's result", async () => {
    await setTimes(otherTeacher, "09:00");
    expect(await lateOnCard(teacher)).toBe(true);
    expect(await lateOnDashboard(teacher)).toBe(1);
  });
});
