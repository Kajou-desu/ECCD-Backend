import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    student: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
    attendance: { findMany: vi.fn(), upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    attendanceVerification: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../src/lib/signedFileUrl.js", () => ({ signFileUrl: vi.fn(() => null) }));
// Ownership itself is covered against the real implementation in
// attendanceOwnership.test.js; here it is stubbed to "allowed".
vi.mock("../src/utils/ownership.js", () => ({
  assertCanAccessStudent: vi.fn(),
  assertCanAccessStudents: vi.fn(),
}));
vi.mock("../src/services/attendanceNotification.service.js", () => ({
  notifyArrival: vi.fn().mockResolvedValue(undefined),
  notifyDeparture: vi.fn().mockResolvedValue(undefined),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { getAttendance, updateAttendance, recordAttendance, getChildAttendance, markDeparted } = await import(
  "../src/controllers/attendance.controller.js"
);
const { notifyArrival, notifyDeparture } = await import("../src/services/attendanceNotification.service.js");
const { schoolDateString } = await import("../src/utils/schoolDate.js");

// Fire-and-forget notifications run on a microtask; let them settle before asserting.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const admin = { id: 1, role: "Admin" };

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
    await getAttendance({ user: admin, query: { date: "2026-09-20" } }, res, vi.fn());

    const out = res.json.mock.calls[0][0];
    expect(out.map((s) => [s.id, s.status, s.verified])).toEqual([
      [1, "present", true], [2, "present", false], [3, "absent", false], [4, null, false],
    ]);
  });

  it("asks for the verification relation in the same query (no N+1)", async () => {
    prisma.student.findMany.mockResolvedValue(students);
    prisma.attendance.findMany.mockResolvedValue([]);
    await getAttendance({ user: admin, query: { date: "2026-09-20" } }, mockRes(), vi.fn());
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
      { user: admin, body: [{ studentId: 1, date: "2026-09-20", status: "present" }, { studentId: 2, date: "2026-09-20", status: "absent" }] },
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

describe("updateAttendance — arrival notification", () => {
  const put = (date, status) =>
    updateAttendance({ params: { studentId: "5" }, body: { date, status } }, mockRes(), vi.fn());

  it("notifies parents when a student is marked present for today", async () => {
    const arrivedAt = new Date();
    prisma.attendance.upsert.mockResolvedValue({ id: 55, studentId: 5, status: "present", arrivedAt });
    await put(schoolDateString(), "present");
    await flush();
    expect(notifyArrival).toHaveBeenCalledWith(5, arrivedAt);
  });

  it("does not notify again when the student is already present today", async () => {
    prisma.attendance.findUnique.mockResolvedValue({ status: "present" });
    prisma.attendance.upsert.mockResolvedValue({ id: 55, studentId: 5, status: "present", arrivedAt: new Date() });
    await put(schoolDateString(), "present");
    await flush();
    expect(notifyArrival).not.toHaveBeenCalled();
  });

  it("notifies again if they were absent and are now marked present", async () => {
    prisma.attendance.findUnique.mockResolvedValue({ status: "absent" });
    prisma.attendance.upsert.mockResolvedValue({ id: 55, studentId: 5, status: "present", arrivedAt: new Date() });
    await put(schoolDateString(), "present");
    await flush();
    expect(notifyArrival).toHaveBeenCalledTimes(1);
  });

  it("does not notify for a past date (a backdated correction is not a live arrival)", async () => {
    prisma.attendance.upsert.mockResolvedValue({ id: 55, studentId: 5, status: "present", arrivedAt: new Date() });
    await put("2020-01-15", "present");
    await flush();
    expect(notifyArrival).not.toHaveBeenCalled();
  });

  it("does not notify for a non-present status, even today", async () => {
    prisma.attendance.upsert.mockResolvedValue({ id: 55, studentId: 5, status: "absent", arrivedAt: null });
    await put(schoolDateString(), "absent");
    await flush();
    expect(notifyArrival).not.toHaveBeenCalled();
  });

  it("still succeeds if the notification blows up", async () => {
    prisma.attendance.upsert.mockResolvedValue({ id: 55, studentId: 5, status: "present", arrivedAt: new Date() });
    notifyArrival.mockRejectedValueOnce(new Error("boom"));
    const res = mockRes();
    const next = vi.fn();
    await updateAttendance({ params: { studentId: "5" }, body: { date: schoolDateString(), status: "present" } }, res, next);
    await flush();
    expect(res.json).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe("re-marking a status resets departure", () => {
  it("updateAttendance clears departedAt on update", async () => {
    prisma.attendance.upsert.mockResolvedValue({ id: 55, studentId: 5, status: "present", arrivedAt: new Date() });
    await updateAttendance({ params: { studentId: "5" }, body: { date: "2026-09-20", status: "present" } }, mockRes(), vi.fn());
    expect(prisma.attendance.upsert.mock.calls[0][0].update.departedAt).toBeNull();
  });
});

describe("recordAttendance — bulk entry", () => {
  it("never sends arrival notifications (bulk/backfill is not a live event)", async () => {
    prisma.$transaction.mockResolvedValue([{ id: 11 }]);
    prisma.attendance.upsert.mockReturnValue({});
    await recordAttendance(
      { user: admin, body: [{ studentId: 1, date: schoolDateString(), status: "present" }] },
      mockRes(), vi.fn(),
    );
    await flush();
    expect(notifyArrival).not.toHaveBeenCalled();
  });
});

describe("markDeparted", () => {
  const call = (studentId = "5") => {
    const res = mockRes();
    const next = vi.fn();
    return markDeparted({ params: { studentId } }, res, next).then(() => ({ res, next }));
  };
  const present = (over = {}) => ({ id: 55, studentId: 5, status: "present", arrivedAt: new Date(), departedAt: null, ...over });

  it("stamps departedAt on today's record and notifies parents", async () => {
    prisma.attendance.findUnique.mockResolvedValue(present());
    prisma.attendance.update.mockImplementation(async ({ data }) => ({ ...present(), ...data }));

    const { res } = await call();
    await flush();

    const { where, data } = prisma.attendance.update.mock.calls[0][0];
    expect(where).toEqual({ id: 55 });
    expect(data.departedAt).toBeInstanceOf(Date);
    expect(res.json).toHaveBeenCalled();
    expect(notifyDeparture).toHaveBeenCalledWith(5, data.departedAt);
  });

  it("looks up today's record only (school-local date)", async () => {
    prisma.attendance.findUnique.mockResolvedValue(null);
    await call();
    const { where } = prisma.attendance.findUnique.mock.calls[0][0];
    expect(where.studentId_date.studentId).toBe(5);
    expect(where.studentId_date.date.toISOString()).toBe(`${schoolDateString()}T00:00:00.000Z`);
  });

  it.each([
    ["no record for today", null],
    ["marked absent", present({ status: "absent", arrivedAt: null })],
    ["present but no arrival time", present({ arrivedAt: null })],
  ])("rejects with 400 when the student never arrived (%s)", async (_label, record) => {
    prisma.attendance.findUnique.mockResolvedValue(record);
    const { res } = await call();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.attendance.update).not.toHaveBeenCalled();
    expect(notifyDeparture).not.toHaveBeenCalled();
  });

  it("rejects with 400 (and does not re-notify) if already departed", async () => {
    prisma.attendance.findUnique.mockResolvedValue(present({ departedAt: new Date() }));
    const { res } = await call();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.attendance.update).not.toHaveBeenCalled();
    expect(notifyDeparture).not.toHaveBeenCalled();
  });

  it("passes an invalid student id to the error handler without touching the DB", async () => {
    const { next } = await call("abc");
    expect(next).toHaveBeenCalled();
    expect(prisma.attendance.findUnique).not.toHaveBeenCalled();
  });
});

describe("departedAt in responses", () => {
  it("getAttendance includes departedAt per student", async () => {
    const departedAt = new Date();
    prisma.student.findMany.mockResolvedValue([{ id: 1, name: "S1", session: "morning", photo: null }]);
    prisma.attendance.findMany.mockResolvedValue([
      { id: 1, studentId: 1, status: "present", arrivedAt: new Date(), departedAt, verification: null },
    ]);
    const res = mockRes();
    await getAttendance({ user: admin, query: { date: "2026-09-20" } }, res, vi.fn());
    expect(res.json.mock.calls[0][0][0].departedAt).toBe(departedAt);
  });
});
