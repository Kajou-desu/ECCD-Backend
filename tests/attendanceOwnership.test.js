import { describe, it, expect, vi, beforeEach } from "vitest";

// Uses the REAL ownership.js (only prisma and the notification side effects
// are stubbed), so these prove a Teacher genuinely cannot mark, depart, bulk-
// write or list another teacher's students — and that a denied request causes
// no write and no parent alert.
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    student: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
    attendance: { findMany: vi.fn(), upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    attendanceVerification: { deleteMany: vi.fn() },
    parentChild: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../src/lib/signedFileUrl.js", () => ({ signFileUrl: vi.fn(() => null) }));
vi.mock("../src/services/attendanceNotification.service.js", () => ({
  notifyArrival: vi.fn().mockResolvedValue(undefined),
  notifyDeparture: vi.fn().mockResolvedValue(undefined),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { getAttendance, updateAttendance, recordAttendance, markDeparted } = await import(
  "../src/controllers/attendance.controller.js"
);
const { notifyArrival, notifyDeparture } = await import(
  "../src/services/attendanceNotification.service.js"
);
const { schoolDateString } = await import("../src/utils/schoolDate.js");

const teacher = { id: 7, role: "Teacher" };
const admin = { id: 1, role: "Admin" };
const flush = () => new Promise((r) => setTimeout(r, 0));

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  return res;
}

function expectForbidden(next) {
  expect(next).toHaveBeenCalledTimes(1);
  expect(next.mock.calls[0][0].status).toBe(403);
}

function expectNoWritesOrAlerts() {
  expect(prisma.attendance.upsert).not.toHaveBeenCalled();
  expect(prisma.attendance.update).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
  expect(prisma.attendanceVerification.deleteMany).not.toHaveBeenCalled();
  expect(notifyArrival).not.toHaveBeenCalled();
  expect(notifyDeparture).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.attendance.upsert.mockResolvedValue({ id: 1, arrivedAt: new Date() });
  prisma.attendance.findUnique.mockResolvedValue(null);
  prisma.attendanceVerification.deleteMany.mockResolvedValue({ count: 0 });
});

const update = (user) => ({
  user,
  params: { studentId: "5" },
  body: { date: schoolDateString(), status: "present" },
});

describe("updateAttendance — ownership", () => {
  it.each([
    ["another teacher's student", { teacherId: 99 }],
    ["an unassigned (teacherId null) student", { teacherId: null }],
    ["a student that doesn't exist", null],
  ])("forbids a Teacher marking %s, with no write and no parent alert", async (_label, row) => {
    prisma.student.findUnique.mockResolvedValue(row);
    const next = vi.fn();

    await updateAttendance(update(teacher), mockRes(), next);
    await flush();

    expectForbidden(next);
    expectNoWritesOrAlerts();
    // Authorization happens before even the "already present?" read.
    expect(prisma.attendance.findUnique).not.toHaveBeenCalled();
  });

  it("allows a Teacher to mark their own student", async () => {
    prisma.student.findUnique.mockResolvedValue({ teacherId: 7 });
    const next = vi.fn();
    const res = mockRes();

    await updateAttendance(update(teacher), res, next);
    await flush();

    expect(next).not.toHaveBeenCalled();
    expect(prisma.attendance.upsert).toHaveBeenCalledTimes(1);
    expect(notifyArrival).toHaveBeenCalledTimes(1);
  });

  it("allows an Admin for any student", async () => {
    const next = vi.fn();
    await updateAttendance(update(admin), mockRes(), next);
    expect(next).not.toHaveBeenCalled();
    expect(prisma.attendance.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("markDeparted — ownership", () => {
  it("forbids a Teacher departing another teacher's student", async () => {
    prisma.student.findUnique.mockResolvedValue({ teacherId: 99 });
    const next = vi.fn();

    await markDeparted({ user: teacher, params: { studentId: "5" } }, mockRes(), next);
    await flush();

    expectForbidden(next);
    expectNoWritesOrAlerts();
    expect(prisma.attendance.findUnique).not.toHaveBeenCalled();
  });

  it("allows a Teacher to depart their own student", async () => {
    prisma.student.findUnique.mockResolvedValue({ teacherId: 7 });
    prisma.attendance.findUnique.mockResolvedValue({
      id: 3, status: "present", arrivedAt: new Date(), departedAt: null,
    });
    prisma.attendance.update.mockResolvedValue({ id: 3 });
    const next = vi.fn();

    await markDeparted({ user: teacher, params: { studentId: "5" } }, mockRes(), next);
    await flush();

    expect(next).not.toHaveBeenCalled();
    expect(notifyDeparture).toHaveBeenCalledTimes(1);
  });
});

describe("recordAttendance (bulk) — ownership", () => {
  const body = (ids) => ids.map((studentId) => ({ studentId, date: "2026-09-20", status: "present" }));

  it("forbids the WHOLE request if any one student isn't the Teacher's (no partial write)", async () => {
    prisma.student.count.mockResolvedValue(2); // owns 2 of the 3 distinct ids
    const next = vi.fn();

    await recordAttendance({ user: teacher, body: body([1, 2, 3]) }, mockRes(), next);

    expectForbidden(next);
    expectNoWritesOrAlerts();
  });

  it("checks ownership with a single scoped query over distinct ids", async () => {
    prisma.student.count.mockResolvedValue(2);
    await recordAttendance({ user: teacher, body: body([1, 2, 2, 1]) }, mockRes(), vi.fn());

    expect(prisma.student.count).toHaveBeenCalledTimes(1);
    expect(prisma.student.count).toHaveBeenCalledWith({
      where: { id: { in: [1, 2] }, teacherId: 7 },
    });
  });

  it("allows a Teacher when every student is theirs", async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    prisma.student.count.mockResolvedValue(3);
    prisma.$transaction.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const res = mockRes();
    const next = vi.fn();

    await recordAttendance({ user: teacher, body: body([1, 2, 3]) }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("allows an Admin without any ownership query", async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    prisma.$transaction.mockResolvedValue([{ id: 1 }]);
    const next = vi.fn();
    await recordAttendance({ user: admin, body: body([1]) }, mockRes(), next);
    expect(next).not.toHaveBeenCalled();
    expect(prisma.student.count).not.toHaveBeenCalled();
  });
});

describe("getAttendance — roster scoping", () => {
  beforeEach(() => {
    prisma.student.findMany.mockResolvedValue([]);
    prisma.attendance.findMany.mockResolvedValue([]);
    prisma.student.count.mockResolvedValue(0);
  });
  const req = (user, query = {}) => ({ user, query: { date: "2026-09-20", ...query } });

  it("limits a Teacher's roster to their own students", async () => {
    await getAttendance(req(teacher), mockRes(), vi.fn());
    expect(prisma.student.findMany.mock.calls[0][0].where).toEqual({ teacherId: 7 });
  });

  it("scopes the paginated total to the same students (no count leak)", async () => {
    await getAttendance(req(teacher, { page: "1", pageSize: "10" }), mockRes(), vi.fn());
    expect(prisma.student.count).toHaveBeenCalledWith({ where: { teacherId: 7 } });
  });

  it("gives an Admin the full roster", async () => {
    await getAttendance(req(admin), mockRes(), vi.fn());
    expect(prisma.student.findMany.mock.calls[0][0].where).toBeUndefined();
  });

  it.each(["Parent", "Guardian", undefined])("denies role %s rather than defaulting to everyone", async (role) => {
    const next = vi.fn();
    await getAttendance(req({ id: 3, role }), mockRes(), next);
    expectForbidden(next);
    expect(prisma.student.findMany).not.toHaveBeenCalled();
  });
});
