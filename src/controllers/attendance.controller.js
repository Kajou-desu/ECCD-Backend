import { prisma } from "../lib/prisma.js";
import { assertCanAccessStudent } from "../utils/ownership.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import {
  parseId,
  parsePagination,
  requireDateString,
  requireMonthString,
  requireAttendanceStatus,
} from "../utils/validate.js";

function toDate(dateString) {
  return new Date(`${dateString}T00:00:00.000Z`);
}

// Teacher/admin only (enforced at route level) — full roster view.
// useAttendance.js expects a FLAT record where `id` is the student's own id
// (it gets passed straight into updateAttendance(id, ...) -> PUT
// /attendance/:studentId), not a nested { student: {...} } shape. It also
// expects every student to appear even if nobody has marked them yet today.
// ?page & ?pageSize are optional; omitting both returns the full roster
// exactly as before (see parsePagination). Total roster size sent via
// X-Total-Count when paginated.
export async function getAttendance(req, res, next) {
  try {
    const date = requireDateString(req.query.date);
    const dateObj = toDate(date);
    const pagination = parsePagination(req.query);

    const [students, total] = await Promise.all([
      prisma.student.findMany({
        select: { id: true, name: true, session: true, photo: true },
        orderBy: { name: "asc" },
        ...(pagination && { skip: pagination.skip, take: pagination.take }),
      }),
      pagination ? prisma.student.count() : Promise.resolve(null),
    ]);

    // Only look up attendance for the students actually returned on this
    // page, not the whole roster.
    const records = await prisma.attendance.findMany({
      where: { date: dateObj, studentId: { in: students.map((s) => s.id) } },
      include: { verification: { select: { id: true } } },
    });
    const attendanceByStudentId = new Map(records.map((r) => [r.studentId, r]));

    const result = students.map((s) => ({
      id: s.id,
      name: s.name,
      session: s.session,
      photo: signFileUrl(req, s.photo),
      status: attendanceByStudentId.get(s.id)?.status ?? null,
      arrivedAt: attendanceByStudentId.get(s.id)?.arrivedAt ?? null,
      // true only for a "present" the system recorded itself (face + BLE); a
      // record a teacher entered or changed by hand is never "verified".
      verified:
        attendanceByStudentId.get(s.id)?.status === "present" &&
        Boolean(attendanceByStudentId.get(s.id)?.verification),
    }));

    if (pagination) res.set("X-Total-Count", String(total));
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// Teacher/admin only (enforced at route level).
export async function updateAttendance(req, res, next) {
  try {
    const studentId = parseId(req.params.studentId, "studentId");
    const date = requireDateString(req.body.date);
    const status = requireAttendanceStatus(req.body.status);

    const record = await prisma.attendance.upsert({
      where: { studentId_date: { studentId, date: toDate(date) } },
      update: {
        status,
        arrivedAt: status === "present" ? new Date() : null,
      },
      create: {
        studentId,
        date: toDate(date),
        status,
        arrivedAt: status === "present" ? new Date() : null,
      },
    });
    // A manual edit supersedes any automatic evidence for this record.
    await prisma.attendanceVerification.deleteMany({ where: { attendanceId: record.id } });
    res.json(record);
  } catch (err) {
    next(err);
  }
}

// Teacher/admin only (enforced at route level).
export async function recordAttendance(req, res, next) {
  try {
    const entries = Array.isArray(req.body) ? req.body : req.body.records;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ message: "Array of attendance records required" });
    }
    if (entries.length > 200) {
      return res.status(400).json({ message: "Too many records in one request" });
    }

    const validated = entries.map((e) => ({
      studentId: parseId(e.studentId, "studentId"),
      date: toDate(requireDateString(e.date)),
      status: requireAttendanceStatus(e.status),
    }));

    const results = await prisma.$transaction(
      validated.map(({ studentId, date, status }) =>
        prisma.attendance.upsert({
          where: { studentId_date: { studentId, date } },
          update: {
            status,
            arrivedAt: status === "present" ? new Date() : null,
          },
          create: {
            studentId,
            date,
            status,
            arrivedAt: status === "present" ? new Date() : null,
          },
        })
      )
    );
    // A manual edit supersedes any automatic evidence for these records.
    await prisma.attendanceVerification.deleteMany({
      where: { attendanceId: { in: results.map((r) => r.id) } },
    });
    res.status(201).json(results);
  } catch (err) {
    next(err);
  }
}

// GET /api/students/:childId/attendance?month=YYYY-MM
// Any authenticated role may call this; Parent/Guardian is restricted to their own children.
// ParentAttendance.jsx does NOT consume a raw array — it expects a composite
// { stats, daily, logs } object, verified against mockParentData.js's
// ATTENDANCE_DATA_BY_CHILD (the app's own ground-truth fixture):
//   stats: { attendanceRate, presentDays, absentDays, excusedDays, lateArrivals }
//   daily: { [dayOfMonth]: "present" | "absent" | "excused" }  (ParentAttendanceCalendar.jsx)
//   logs:  [{ date, status, time }]                            (ParentRecentLogs.jsx)
export async function getChildAttendance(req, res, next) {
  try {
    const childId = parseId(req.params.childId, "childId");
    const month = requireMonthString(req.query.month);

    await assertCanAccessStudent(req.user, childId);

    const [year, mon] = month.split("-").map(Number);
    const start = new Date(Date.UTC(year, mon - 1, 1));
    const end = new Date(Date.UTC(year, mon, 1));

    const records = await prisma.attendance.findMany({
      where: { studentId: childId, date: { gte: start, lt: end } },
      orderBy: { date: "asc" },
    });

    const daily = {};
    let presentDays = 0;
    let absentDays = 0;
    let excusedDays = 0;

    const logs = records.map((r) => {
      const day = r.date.getUTCDate();
      daily[day] = r.status;

      if (r.status === "present") presentDays += 1;
      else if (r.status === "absent") absentDays += 1;
      else if (r.status === "excused") excusedDays += 1;

      return {
        date: r.date.toLocaleDateString("en-US", {
          month: "short",
          day: "2-digit",
          year: "numeric",
        }),
        status: r.status,
        arrivedAt: r.arrivedAt,
      };
    });
    logs.reverse(); // most recent first, matching "Recent Logs"

    const totalRecorded = records.length;
    const attendanceRate =
      totalRecorded > 0 ? Math.round((presentDays / totalRecorded) * 100) : 0;

    res.json({
      stats: {
        attendanceRate,
        presentDays,
        absentDays,
        excusedDays,
        lateArrivals: 0, // not tracked — no source of truth for this yet
      },
      daily,
      logs,
    });
  } catch (err) {
    next(err);
  }
}
