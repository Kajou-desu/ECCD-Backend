import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    student: { findMany: vi.fn() },
    attendance: { findMany: vi.fn(), upsert: vi.fn() },
    attendanceVerification: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../src/lib/signedFileUrl.js", () => ({ signFileUrl: vi.fn(() => null) }));
vi.mock("../src/utils/ownership.js", () => ({
  assertCanAccessStudent: vi.fn(),
  assertCanAccessStudents: vi.fn(),
}));
vi.mock("../src/services/attendanceNotification.service.js", () => ({
  notifyArrival: vi.fn(),
  notifyDeparture: vi.fn(),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { assertCanAccessStudent } = await import("../src/utils/ownership.js");
const { getAttendanceRange, importAttendance } = await import("../src/controllers/attendanceBulk.controller.js");

const admin = { id: 1, role: "Admin" };
const teacher = { id: 5, role: "Teacher" };
const parent = { id: 9, role: "Parent" };

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async (ops) => Promise.all(ops));
  prisma.attendance.upsert.mockImplementation(async ({ create }) => ({ id: 100 + create.studentId, ...create }));
});

describe("getAttendanceRange", () => {
  const call = async (query, user = admin) => {
    const res = mockRes();
    const next = vi.fn();
    await getAttendanceRange({ query, user }, res, next);
    return { res, next };
  };

  it("returns recorded days in the range as flat rows", async () => {
    prisma.attendance.findMany.mockResolvedValue([
      {
        studentId: 3,
        date: new Date("2026-09-02T00:00:00.000Z"),
        status: "present",
        arrivedAt: new Date("2026-09-02T00:05:00.000Z"),
        departedAt: null,
        student: { name: "Ana Cruz", studentCode: "ECCD-2026-3", session: "morning" },
      },
    ]);
    const { res } = await call({ from: "2026-09-01", to: "2026-09-07" });
    expect(res.json.mock.calls[0][0].records).toEqual([
      expect.objectContaining({ studentCode: "ECCD-2026-3", name: "Ana Cruz", date: "2026-09-02", status: "present" }),
    ]);
  });

  it("limits a Teacher to their own students", async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    await call({ from: "2026-09-01", to: "2026-09-07" }, teacher);
    expect(prisma.attendance.findMany.mock.calls[0][0].where.student).toEqual({ teacherId: 5 });
  });

  it("forbids roles other than Teacher and Admin", async () => {
    const { next } = await call({ from: "2026-09-01", to: "2026-09-07" }, parent);
    expect(next.mock.calls[0][0].status).toBe(403);
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
  });

  it("checks access before returning one student's records", async () => {
    assertCanAccessStudent.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
    const { next } = await call({ from: "2026-09-01", to: "2026-09-07", studentId: "8" }, teacher);
    expect(next).toHaveBeenCalled();
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
  });

  it.each([
    [{ from: "2026-09-10", to: "2026-09-01" }],
    [{ from: "2026-01-01", to: "2026-12-31" }],
    [{ from: "nope", to: "2026-09-01" }],
    [{ to: "2026-09-01" }],
  ])("rejects an invalid range %j with a 400", async (query) => {
    const { next } = await call(query);
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
  });
});

describe("importAttendance", () => {
  const run = async (body, user = teacher) => {
    const res = mockRes();
    const next = vi.fn();
    await importAttendance({ body, user }, res, next);
    return { res, next, payload: res.json.mock.calls[0]?.[0] };
  };

  it("creates, updates and skips unchanged records, and reports bad rows by row number", async () => {
    prisma.student.findMany.mockResolvedValue([
      { id: 1, studentCode: "A" },
      { id: 2, studentCode: "B" },
    ]);
    prisma.attendance.findMany.mockResolvedValue([
      { studentId: 1, date: new Date("2026-09-01T00:00:00.000Z"), status: "present" }, // unchanged
      { studentId: 2, date: new Date("2026-09-01T00:00:00.000Z"), status: "absent" }, // updated
    ]);
    const { payload } = await run({
      records: [
        { studentCode: "A", date: "2026-09-01", status: "present" },
        { studentCode: "B", date: "2026-09-01", status: "excused" },
        { studentCode: "A", date: "2026-09-02", status: "absent" }, // created
        { studentCode: "ZZ", date: "2026-09-01", status: "present" }, // unknown
        { studentCode: "A", date: "2026-09-01", status: "absent" }, // duplicate of row 2
        { studentCode: "A", date: "2026-09-03", status: "late" }, // bad status
      ],
    });
    expect(payload).toMatchObject({ dryRun: false, created: 1, updated: 1, unchanged: 1 });
    expect(payload.failed.map((f) => f.row)).toEqual([5, 6, 7]);
    expect(prisma.attendance.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.attendanceVerification.deleteMany).toHaveBeenCalledOnce();
  });

  it("writes nothing on a dry run", async () => {
    prisma.student.findMany.mockResolvedValue([{ id: 1, studentCode: "A" }]);
    prisma.attendance.findMany.mockResolvedValue([]);
    const { payload } = await run({ dryRun: true, records: [{ studentCode: "A", date: "2026-09-01", status: "present" }] });
    expect(payload).toMatchObject({ dryRun: true, created: 1, updated: 0, unchanged: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.attendance.upsert).not.toHaveBeenCalled();
  });

  it("resolves codes only inside a Teacher's own students, and treats others as not found", async () => {
    prisma.student.findMany.mockResolvedValue([]);
    const { payload } = await run({ records: [{ studentCode: "OTHERS", date: "2026-09-01", status: "present" }] });
    expect(prisma.student.findMany.mock.calls[0][0].where).toMatchObject({ teacherId: 5 });
    expect(payload.failed).toEqual([{ row: 2, message: expect.stringContaining("was not found") }]);
    expect(prisma.attendance.upsert).not.toHaveBeenCalled();
  });

  it("rejects future dates per row", async () => {
    prisma.student.findMany.mockResolvedValue([{ id: 1, studentCode: "A" }]);
    prisma.attendance.findMany.mockResolvedValue([]);
    const { payload } = await run({ records: [{ studentCode: "A", date: "2099-01-01", status: "present" }] });
    expect(payload.failed[0].message).toMatch(/future/i);
    expect(prisma.attendance.upsert).not.toHaveBeenCalled();
  });

  it("does not stamp an arrival time on back-dated present records", async () => {
    prisma.student.findMany.mockResolvedValue([{ id: 1, studentCode: "A" }]);
    prisma.attendance.findMany.mockResolvedValue([]);
    await run({ records: [{ studentCode: "A", date: "2026-09-01", status: "present" }] });
    expect(prisma.attendance.upsert.mock.calls[0][0].create.arrivedAt).toBeNull();
  });

  it.each([[{}], [{ records: [] }], [{ records: "x" }]])("answers 400 for %j", async (body) => {
    const { res } = await run(body);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("answers 400 above 500 records", async () => {
    const records = Array.from({ length: 501 }, () => ({ studentCode: "A", date: "2026-09-01", status: "present" }));
    const { res } = await run({ records });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("forbids Parent and Guardian accounts", async () => {
    const { next } = await run({ records: [{ studentCode: "A", date: "2026-09-01", status: "present" }] }, parent);
    expect(next.mock.calls[0][0].status).toBe(403);
  });

  it("tolerates non-object entries without a 500", async () => {
    prisma.student.findMany.mockResolvedValue([]);
    const { payload, next } = await run({ records: [null, 5, ["x"]] });
    expect(next).not.toHaveBeenCalled();
    expect(payload.failed).toHaveLength(3);
  });
});
