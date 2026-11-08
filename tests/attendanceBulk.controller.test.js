import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    student: { findMany: vi.fn() },
    attendance: { findMany: vi.fn(), upsert: vi.fn(), count: vi.fn(), deleteMany: vi.fn() },
    attendanceVerification: { deleteMany: vi.fn() },
    schoolTimeSettings: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../src/lib/signedFileUrl.js", () => ({ signFileUrl: vi.fn(() => null) }));
vi.mock("../src/utils/ownership.js", async (importOriginal) => ({
  ...(await importOriginal()), // the real studentScopeFor
  assertCanAccessStudent: vi.fn(),
  assertCanAccessStudents: vi.fn(),
}));
vi.mock("../src/services/attendanceNotification.service.js", () => ({
  notifyArrival: vi.fn(),
  notifyPickup: vi.fn(),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { assertCanAccessStudent, assertCanAccessStudents } = await import("../src/utils/ownership.js");
const { getAttendanceRange, importAttendance, deleteAttendance } = await import(
  "../src/controllers/attendanceBulk.controller.js"
);

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

  it("flags a present arrival after the session cutoff as late", async () => {
    const row = (studentId, arrivedAt, session = "morning") => ({
      studentId,
      date: new Date("2026-09-02T00:00:00.000Z"),
      status: "present",
      arrivedAt,
      pickedUpAt: null,
      student: { name: `S${studentId}`, studentCode: `C${studentId}`, session },
    });
    prisma.attendance.findMany.mockResolvedValue([
      row(1, new Date("2026-09-01T23:55:00.000Z")), // 7:55 AM
      row(2, new Date("2026-09-02T00:30:00.000Z")), // 8:30 AM
      row(3, null),
    ]);
    const { res } = await call({ from: "2026-09-02", to: "2026-09-02" });
    expect(res.json.mock.calls[0][0].records.map((r) => r.late)).toEqual([false, true, false]);
  });

  it("flags late against the student's own center's school times", async () => {
    const row = (studentId, centerId) => ({
      studentId,
      date: new Date("2026-09-02T00:00:00.000Z"),
      status: "present",
      arrivedAt: new Date("2026-09-02T00:20:00.000Z"), // 8:20 AM
      pickedUpAt: null,
      student: { name: `S${studentId}`, studentCode: `C${studentId}`, session: "morning", teacher: { centerId } },
    });
    prisma.attendance.findMany.mockResolvedValue([row(1, 10), row(2, 20)]);
    prisma.schoolTimeSettings.findMany.mockResolvedValue([
      { centerId: 10, morningStartMin: 8 * 60 + 30, afternoonStartMin: 13 * 60 }, // center 20 keeps the 8:00 default
    ]);
    const { res } = await call({ from: "2026-09-02", to: "2026-09-02" });
    expect(res.json.mock.calls[0][0].records.map((r) => [r.studentId, r.late])).toEqual([[1, false], [2, true]]);
  });

  it("returns recorded days in the range as flat rows", async () => {
    prisma.attendance.findMany.mockResolvedValue([
      {
        studentId: 3,
        date: new Date("2026-09-02T00:00:00.000Z"),
        status: "present",
        arrivedAt: new Date("2026-09-02T00:05:00.000Z"),
        pickedUpAt: null,
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
      { id: 1, name: "Ana Cruz" },
      { id: 2, name: "Ben Reyes" },
    ]);
    prisma.attendance.findMany.mockResolvedValue([
      { studentId: 1, date: new Date("2026-09-01T00:00:00.000Z"), status: "present" }, // unchanged
      { studentId: 2, date: new Date("2026-09-01T00:00:00.000Z"), status: "absent" }, // updated
    ]);
    const { payload } = await run({
      records: [
        { studentName: "Ana Cruz", date: "2026-09-01", status: "present" },
        { studentName: "Ben Reyes", date: "2026-09-01", status: "excused" },
        { studentName: "Ana Cruz", date: "2026-09-02", status: "absent" }, // created
        { studentName: "Nobody Here", date: "2026-09-01", status: "present" }, // unknown
        { studentName: "Ana Cruz", date: "2026-09-01", status: "absent" }, // duplicate of row 2
        { studentName: "Ana Cruz", date: "2026-09-03", status: "late" }, // bad status
      ],
    });
    expect(payload).toMatchObject({ dryRun: false, created: 1, updated: 1, unchanged: 1 });
    expect(payload.failed.map((f) => f.row)).toEqual([5, 6, 7]);
    expect(prisma.attendance.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.attendanceVerification.deleteMany).toHaveBeenCalledOnce();
  });

  it("matches names ignoring case, extra spaces and how an accent was typed", async () => {
    prisma.student.findMany.mockResolvedValue([{ id: 1, name: "José Dela Cruz" }]);
    prisma.attendance.findMany.mockResolvedValue([]);
    const { payload } = await run({
      dryRun: true,
      records: [
        { studentName: "  josé DELA   cruz ", date: "2026-09-01", status: "present" }, // e + combining accent
        { studentName: "José Dela Cruz", date: "2026-09-02", status: "present" },
      ],
    });
    expect(payload).toMatchObject({ created: 2, failed: [] });
  });

  it("refuses a name shared by several of the caller's students instead of guessing", async () => {
    prisma.student.findMany.mockResolvedValue([
      { id: 1, name: "Ana Cruz" },
      { id: 2, name: "ana  cruz" }, // same person-name, different student
      { id: 3, name: "Ben Reyes" },
    ]);
    prisma.attendance.findMany.mockResolvedValue([]);
    const { payload } = await run({
      records: [
        { studentName: "Ana Cruz", date: "2026-09-01", status: "present" },
        { studentName: "Ben Reyes", date: "2026-09-01", status: "present" },
      ],
    });
    expect(payload.failed).toEqual([{ row: 2, message: expect.stringContaining("2 students are named") }]);
    expect(payload).toMatchObject({ created: 1 });
    expect(prisma.attendance.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.attendance.upsert.mock.calls[0][0].create.studentId).toBe(3);
  });

  it("writes nothing on a dry run", async () => {
    prisma.student.findMany.mockResolvedValue([{ id: 1, name: "Ana Cruz" }]);
    prisma.attendance.findMany.mockResolvedValue([]);
    const { payload } = await run({ dryRun: true, records: [{ studentName: "Ana Cruz", date: "2026-09-01", status: "present" }] });
    expect(payload).toMatchObject({ dryRun: true, created: 1, updated: 0, unchanged: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.attendance.upsert).not.toHaveBeenCalled();
  });

  it("resolves names only inside a Teacher's own students, and treats others as not found", async () => {
    prisma.student.findMany.mockResolvedValue([]);
    const { payload } = await run({ records: [{ studentName: "Someone Else's", date: "2026-09-01", status: "present" }] });
    expect(prisma.student.findMany.mock.calls[0][0].where).toMatchObject({ teacherId: 5 });
    expect(payload.failed).toEqual([{ row: 2, message: expect.stringContaining("was not found") }]);
    expect(prisma.attendance.upsert).not.toHaveBeenCalled();
  });

  it("no longer accepts a student code in place of a name", async () => {
    prisma.student.findMany.mockResolvedValue([{ id: 1, name: "Ana Cruz" }]);
    const { payload } = await run({ records: [{ studentCode: "ECCD-2026-1", date: "2026-09-01", status: "present" }] });
    expect(payload.failed).toEqual([{ row: 2, message: "Student Name is required" }]);
    expect(prisma.attendance.upsert).not.toHaveBeenCalled();
  });

  it.each([[""], ["   "], [null], [42], ["x".repeat(201)]])("rejects the student name %j", async (studentName) => {
    prisma.student.findMany.mockResolvedValue([]);
    const { payload } = await run({ records: [{ studentName, date: "2026-09-01", status: "present" }] });
    expect(payload.failed).toEqual([{ row: 2, message: "Student Name is required" }]);
  });

  it("rejects future dates per row", async () => {
    prisma.student.findMany.mockResolvedValue([{ id: 1, name: "Ana Cruz" }]);
    prisma.attendance.findMany.mockResolvedValue([]);
    const { payload } = await run({ records: [{ studentName: "Ana Cruz", date: "2099-01-01", status: "present" }] });
    expect(payload.failed[0].message).toMatch(/future/i);
    expect(prisma.attendance.upsert).not.toHaveBeenCalled();
  });

  it("rejects a date that does not exist, per row", async () => {
    prisma.student.findMany.mockResolvedValue([{ id: 1, name: "Ana Cruz" }]);
    prisma.attendance.findMany.mockResolvedValue([]);
    const { payload } = await run({ records: [{ studentName: "Ana Cruz", date: "2026-02-30", status: "present" }] });
    expect(payload.failed).toHaveLength(1);
    expect(prisma.attendance.upsert).not.toHaveBeenCalled();
  });

  it("does not stamp an arrival time on back-dated present records", async () => {
    prisma.student.findMany.mockResolvedValue([{ id: 1, name: "Ana Cruz" }]);
    prisma.attendance.findMany.mockResolvedValue([]);
    await run({ records: [{ studentName: "Ana Cruz", date: "2026-09-01", status: "present" }] });
    expect(prisma.attendance.upsert.mock.calls[0][0].create.arrivedAt).toBeNull();
  });

  it.each([[{}], [{ records: [] }], [{ records: "x" }]])("answers 400 for %j", async (body) => {
    const { res } = await run(body);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("answers 400 above 500 records", async () => {
    const records = Array.from({ length: 501 }, () => ({ studentName: "Ana Cruz", date: "2026-09-01", status: "present" }));
    const { res } = await run({ records });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("forbids Parent and Guardian accounts", async () => {
    const { next } = await run({ records: [{ studentName: "Ana Cruz", date: "2026-09-01", status: "present" }] }, parent);
    expect(next.mock.calls[0][0].status).toBe(403);
  });

  it("tolerates non-object entries without a 500", async () => {
    prisma.student.findMany.mockResolvedValue([]);
    const { payload, next } = await run({ records: [null, 5, ["x"]] });
    expect(next).not.toHaveBeenCalled();
    expect(payload.failed).toHaveLength(3);
  });
});

describe("deleteAttendance", () => {
  const run = async (body, user = teacher) => {
    const res = mockRes();
    const next = vi.fn();
    await deleteAttendance({ body, user }, res, next);
    return { res, next, payload: res.json.mock.calls[0]?.[0] };
  };
  const whereOf = () => prisma.attendance.deleteMany.mock.calls[0][0].where;

  beforeEach(() => {
    prisma.attendance.deleteMany.mockResolvedValue({ count: 3 });
    prisma.attendance.count.mockResolvedValue(3);
  });

  it("deletes one student's record for one day", async () => {
    const { payload } = await run({ from: "2026-09-01", studentIds: [7] });
    expect(payload).toEqual({ dryRun: false, deleted: 3 });
    expect(assertCanAccessStudents).toHaveBeenCalledWith(teacher, [7]);
    expect(whereOf()).toEqual({
      date: { gte: new Date("2026-09-01T00:00:00.000Z"), lte: new Date("2026-09-01T00:00:00.000Z") },
      student: { id: { in: [7] }, teacherId: 5 },
    });
  });

  it("deletes several students over a date range, ignoring repeated ids", async () => {
    await run({ from: "2026-09-01", to: "2026-09-05", studentIds: [7, "8", 7] });
    expect(assertCanAccessStudents).toHaveBeenCalledWith(teacher, [7, 8]);
    expect(whereOf().date).toEqual({
      gte: new Date("2026-09-01T00:00:00.000Z"),
      lte: new Date("2026-09-05T00:00:00.000Z"),
    });
    expect(whereOf().student.id).toEqual({ in: [7, 8] });
  });

  it("deletes for all of a Teacher's students, scoped to their students only", async () => {
    await run({ from: "2026-09-01", allStudents: true });
    expect(assertCanAccessStudents).not.toHaveBeenCalled();
    expect(whereOf().student).toEqual({ teacherId: 5 });
  });

  it("lets an Admin delete for every student", async () => {
    await run({ from: "2026-09-01", allStudents: true }, admin);
    expect(whereOf().student).toEqual({});
  });

  it("only counts on a dry run", async () => {
    const { payload } = await run({ from: "2026-09-01", allStudents: true, dryRun: true });
    expect(payload).toEqual({ dryRun: true, wouldDelete: 3 });
    expect(prisma.attendance.deleteMany).not.toHaveBeenCalled();
    expect(prisma.attendance.count.mock.calls[0][0].where.student).toEqual({ teacherId: 5 });
  });

  it("forbids the whole request when any student is outside the caller's scope", async () => {
    assertCanAccessStudents.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
    const { next } = await run({ from: "2026-09-01", studentIds: [7, 999] });
    expect(next.mock.calls[0][0].status).toBe(403);
    expect(prisma.attendance.deleteMany).not.toHaveBeenCalled();
  });

  it("forbids Parent and Guardian accounts before touching anything", async () => {
    const { next } = await run({ from: "2026-09-01", allStudents: true }, parent);
    expect(next.mock.calls[0][0].status).toBe(403);
    expect(prisma.attendance.deleteMany).not.toHaveBeenCalled();
    expect(prisma.attendance.count).not.toHaveBeenCalled();
  });

  it.each([
    ["neither studentIds nor allStudents", { from: "2026-09-01" }],
    ["both studentIds and allStudents", { from: "2026-09-01", studentIds: [1], allStudents: true }],
    ["allStudents that is not exactly true", { from: "2026-09-01", allStudents: "true" }],
    ["allStudents false and no ids", { from: "2026-09-01", allStudents: false }],
    ["an empty studentIds list", { from: "2026-09-01", studentIds: [] }],
    ["studentIds that is not a list", { from: "2026-09-01", studentIds: "1" }],
    ["too many studentIds", { from: "2026-09-01", studentIds: Array.from({ length: 1001 }, (_, i) => i + 1) }],
    ["a non-numeric student id", { from: "2026-09-01", studentIds: ["abc"] }],
    ["a missing date", { studentIds: [1] }],
    ["a malformed date", { from: "09/01/2026", studentIds: [1] }],
    ["a date that does not exist", { from: "2026-02-30", studentIds: [1] }],
    ["from after to", { from: "2026-09-10", to: "2026-09-01", studentIds: [1] }],
    ["a range over 92 days", { from: "2026-01-01", to: "2026-12-31", studentIds: [1] }],
  ])("answers 400 for %s", async (_label, body) => {
    const { next } = await run(body);
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(prisma.attendance.deleteMany).not.toHaveBeenCalled();
    expect(prisma.attendance.count).not.toHaveBeenCalled();
  });

  it("answers 400, not a crash, for a missing body", async () => {
    const { next } = await run(undefined);
    expect(next.mock.calls[0][0].status).toBe(400);
  });
});
