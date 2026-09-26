import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    student: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
    attendance: { findMany: vi.fn(), upsert: vi.fn() },
    attendanceVerification: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../src/lib/signedFileUrl.js", () => ({ signFileUrl: vi.fn(() => null) }));
vi.mock("../src/utils/ownership.js", () => ({ assertCanAccessStudent: vi.fn() }));

const { prisma } = await import("../src/lib/prisma.js");
const { getAttendance, updateAttendance, recordAttendance, getChildAttendance } = await import(
  "../src/controllers/attendance.controller.js"
);

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.attendanceVerification.deleteMany.mockResolvedValue({ count: 1 });
});

describe("getAttendance — verified flag", () => {
  const students = [1, 2, 3, 4].map((id) => ({ id, name: `S${id}`, session: "morning", photo: null }));
  const rec = (studentId, status, verification) => ({ id: 100 + studentId, studentId, status, arrivedAt: null, verification });

  it("is true only for a 'present' record that has system evidence", async () => {
    prisma.student.findMany.mockResolvedValue(students);
    prisma.attendance.findMany.mockResolvedValue([
      rec(1, "present", { id: 9 }),  // auto-verified
      rec(2, "present", null),       // marked by hand
      rec(3, "absent", { id: 9 }),   // stale evidence on a non-present record
      // student 4: no record at all
    ]);
    const res = mockRes();
    await getAttendance({ query: { date: "2026-09-20" } }, res, vi.fn());

    const out = res.json.mock.calls[0][0];
    expect(out.map((s) => [s.id, s.status, s.verified])).toEqual([
      [1, "present", true], [2, "present", false], [3, "absent", false], [4, null, false],
    ]);
  });

  it("asks for the verification relation in the same query (no N+1)", async () => {
    prisma.student.findMany.mockResolvedValue(students);
    prisma.attendance.findMany.mockResolvedValue([]);
    await getAttendance({ query: { date: "2026-09-20" } }, mockRes(), vi.fn());
    expect(prisma.attendance.findMany.mock.calls[0][0].include).toEqual({ verification: { select: { id: true } } });
  });
});

describe("manual edits supersede automatic evidence", () => {
  it("updateAttendance clears the verification of the record it changed", async () => {
    prisma.attendance.upsert.mockResolvedValue({ id: 55, studentId: 5, status: "absent" });
    await updateAttendance({ params: { studentId: "5" }, body: { date: "2026-09-20", status: "absent" } }, mockRes(), vi.fn());
    expect(prisma.attendanceVerification.deleteMany).toHaveBeenCalledWith({ where: { attendanceId: 55 } });
  });

  it("recordAttendance clears verification for every record it wrote", async () => {
    prisma.$transaction.mockResolvedValue([{ id: 11 }, { id: 12 }]);
    prisma.attendance.upsert.mockReturnValue({});
    await recordAttendance(
      { body: [{ studentId: 1, date: "2026-09-20", status: "present" }, { studentId: 2, date: "2026-09-20", status: "absent" }] },
      mockRes(), vi.fn(),
    );
    expect(prisma.attendanceVerification.deleteMany).toHaveBeenCalledWith({ where: { attendanceId: { in: [11, 12] } } });
  });

  it("does not clear anything when validation fails", async () => {
    const next = vi.fn();
    await updateAttendance({ params: { studentId: "5" }, body: { date: "not-a-date", status: "present" } }, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(prisma.attendanceVerification.deleteMany).not.toHaveBeenCalled();
  });
});

describe("getChildAttendance — lateArrivals", () => {
  // Default SCHOOL_TIMEZONE is Asia/Manila (UTC+8), so local 8:00 AM is
  // 00:00 UTC and local 1:00 PM is 05:00 UTC on the same school day.
  const record = (day, arrivedAtUtc) => ({
    date: new Date(Date.UTC(2026, 8, day)), // September (0-indexed month 8)
    status: "present",
    arrivedAt: arrivedAtUtc ? new Date(arrivedAtUtc) : null,
  });
  const req = () => ({
    params: { childId: "7" },
    query: { month: "2026-09" },
    user: { id: 1, role: "Teacher" },
  });

  it("counts a morning-session arrival after 8:00 AM local time as late", async () => {
    prisma.student.findUnique.mockResolvedValue({ session: "morning" });
    prisma.attendance.findMany.mockResolvedValue([
      record(1, "2026-08-31T23:59:00.000Z"), // 07:59 AM local — on time
      record(2, "2026-09-01T00:00:00.000Z"), // exactly 08:00 AM local — on time
      record(3, "2026-09-01T00:01:00.000Z"), // 08:01 AM local — late
    ]);
    const res = mockRes();
    await getChildAttendance(req(), res, vi.fn());
    expect(res.json.mock.calls[0][0].stats.lateArrivals).toBe(1);
  });

  it("counts an afternoon-session arrival after 1:00 PM local time as late", async () => {
    prisma.student.findUnique.mockResolvedValue({ session: "afternoon" });
    prisma.attendance.findMany.mockResolvedValue([
      record(1, "2026-09-01T04:59:00.000Z"), // 12:59 PM local — on time
      record(2, "2026-09-01T05:01:00.000Z"), // 01:01 PM local — late
    ]);
    const res = mockRes();
    await getChildAttendance(req(), res, vi.fn());
    expect(res.json.mock.calls[0][0].stats.lateArrivals).toBe(1);
  });

  it("never counts a present record with no arrivedAt as late", async () => {
    prisma.student.findUnique.mockResolvedValue({ session: "morning" });
    prisma.attendance.findMany.mockResolvedValue([record(1, null)]);
    const res = mockRes();
    await getChildAttendance(req(), res, vi.fn());
    expect(res.json.mock.calls[0][0].stats.lateArrivals).toBe(0);
  });

  it("falls back to the morning cutoff when the student has no session on file", async () => {
    prisma.student.findUnique.mockResolvedValue(null);
    prisma.attendance.findMany.mockResolvedValue([
      record(1, "2026-09-01T00:01:00.000Z"), // 08:01 AM local — late under the morning cutoff
    ]);
    const res = mockRes();
    await getChildAttendance(req(), res, vi.fn());
    expect(res.json.mock.calls[0][0].stats.lateArrivals).toBe(1);
  });
});
