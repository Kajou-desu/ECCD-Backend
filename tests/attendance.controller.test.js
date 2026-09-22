import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    student: { findMany: vi.fn(), count: vi.fn() },
    attendance: { findMany: vi.fn(), upsert: vi.fn() },
    attendanceVerification: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../src/lib/signedFileUrl.js", () => ({ signFileUrl: vi.fn(() => null) }));

const { prisma } = await import("../src/lib/prisma.js");
const { getAttendance, updateAttendance, recordAttendance } = await import(
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
