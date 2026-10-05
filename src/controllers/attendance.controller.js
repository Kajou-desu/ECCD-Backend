import { prisma } from "../lib/prisma.js";
import { assertCanAccessStudent, assertCanAccessStudents } from "../utils/ownership.js";
import { AppError } from "../middleware/errorHandler.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { schoolMinutesOfDay, schoolDateString } from "../utils/schoolDate.js";
import { notifyArrival, notifyDeparture } from "../services/attendanceNotification.service.js";
import {
  parseId,
  parsePagination,
  requireDateString,
  requireMonthString,
  requireAttendanceStatus,
} from "../utils/validate.js";

// A student is "late" if they arrive after their session's start-of-day
// cutoff, in the school's own timezone (not the server's/UTC's) — see
// schoolMinutesOfDay. Morning session: after 8:00 AM. Afternoon session:
// after 1:00 PM (13:00). Keyed by the Session enum values in validate.js.
const LATE_CUTOFF_MINUTES = { morning: 8 * 60, afternoon: 13 * 60 };

function toDate(dateString) {
  return new Date(`${dateString}T00:00:00.000Z`);
}

// Attendance can be recorded for today or any past day, never a future one.
// "Today" is the school's own calendar day, and YYYY-MM-DD strings compare
// correctly as plain strings.
function assertNotFutureDate(dateString) {
  if (dateString > schoolDateString()) {
    throw new AppError("Attendance cannot be recorded for a future date", 400);
  }
}

// A real arrival time exists only when the teacher marks today's record. A
// back-dated "present" has no known arrival, so it stays null instead of
// being stamped with the moment of editing (which would also make the
// parent view count it as late).
function arrivedAtFor(status, dateString) {
  return status === "present" && dateString === schoolDateString() ? new Date() : null;
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

    // Same rule as the Student Info list: a Teacher sees only the students
    // connected to them (Student.teacherId), an Admin sees everyone. Anything
    // else is denied rather than defaulting to the full roster.
    if (req.user.role !== "Teacher" && req.user.role !== "Admin") {
      throw new AppError("Forbidden", 403);
    }
    const where = req.user.role === "Teacher" ? { teacherId: req.user.id } : undefined;

    const [students, total] = await Promise.all([
      prisma.student.findMany({
        where,
        select: { id: true, name: true, session: true, photo: true },
        orderBy: { name: "asc" },
        ...(pagination && { skip: pagination.skip, take: pagination.take }),
      }),
      pagination ? prisma.student.count({ where }) : Promise.resolve(null),
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
      departedAt: attendanceByStudentId.get(s.id)?.departedAt ?? null,
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
    assertNotFutureDate(date);

    // Authorize BEFORE any read or write: a Teacher may only mark their own
    // students, otherwise this would also alert another class's parents.
    await assertCanAccessStudent(req.user, studentId);

    // Only a genuine change TO present is an arrival. Re-saving "present" for
    // a student who is already present must not text/email their parents
    // again (SMS costs money, and repeat saves would spam them). Read before
    // the write, and only when it can matter.
    const isLiveArrival = status === "present" && date === schoolDateString();
    const alreadyPresent = isLiveArrival
      ? (await prisma.attendance.findUnique({
          where: { studentId_date: { studentId, date: toDate(date) } },
          select: { status: true },
        }))?.status === "present"
      : false;

    const record = await prisma.attendance.upsert({
      where: { studentId_date: { studentId, date: toDate(date) } },
      update: {
        status,
        arrivedAt: arrivedAtFor(status, date),
        // Re-marking a status re-asserts the day from scratch: a stale
        // departure must not survive (e.g. present -> departed -> absent ->
        // present would otherwise show as already departed).
        departedAt: null,
      },
      create: {
        studentId,
        date: toDate(date),
        status,
        arrivedAt: arrivedAtFor(status, date),
      },
    });
    // A manual edit supersedes any automatic evidence for this record.
    await prisma.attendanceVerification.deleteMany({ where: { attendanceId: record.id } });

    // Only for today: a teacher backdating/correcting a past day's record is
    // not a live arrival, and must not tell a parent their child "just
    // arrived" for something that happened (or didn't) days ago. Fire-and-
    // forget — this is a synchronous UI save and must not wait on an
    // email/SMS round trip.
    if (isLiveArrival && !alreadyPresent) {
      Promise.resolve()
        .then(() => notifyArrival(studentId, record.arrivedAt))
        .catch(() => {});
    }

    res.json(record);
  } catch (err) {
    next(err);
  }
}

// Teacher/admin only (enforced at route level). Marks TODAY's record as
// departed. There is no hardware "left the building" signal (BLE only
// proves nearness at the door, not an exit), so — unlike arrival — this is
// always a deliberate, manual action.
export async function markDeparted(req, res, next) {
  try {
    const studentId = parseId(req.params.studentId, "studentId");
    await assertCanAccessStudent(req.user, studentId);
    const today = toDate(schoolDateString());

    const existing = await prisma.attendance.findUnique({
      where: { studentId_date: { studentId, date: today } },
    });

    if (!existing || existing.status !== "present" || !existing.arrivedAt) {
      return res.status(400).json({ message: "Student has no arrival recorded for today" });
    }
    if (existing.departedAt) {
      return res.status(400).json({ message: "Student is already marked departed for today" });
    }

    const departedAt = new Date();
    const record = await prisma.attendance.update({
      where: { id: existing.id },
      data: { departedAt },
    });

    // Fire-and-forget, same reasoning as the arrival notification above.
    Promise.resolve()
      .then(() => notifyDeparture(studentId, departedAt))
      .catch(() => {});

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

    const validated = entries.map((e) => {
      const dateString = requireDateString(e.date);
      assertNotFutureDate(dateString);
      return {
        studentId: parseId(e.studentId, "studentId"),
        dateString,
        date: toDate(dateString),
        status: requireAttendanceStatus(e.status),
      };
    });

    // All-or-nothing ownership check before the transaction opens.
    await assertCanAccessStudents(req.user, validated.map((e) => e.studentId));

    const results = await prisma.$transaction(
      validated.map(({ studentId, date, dateString, status }) =>
        prisma.attendance.upsert({
          where: { studentId_date: { studentId, date } },
          update: {
            status,
            arrivedAt: arrivedAtFor(status, dateString),
            departedAt: null,
          },
          create: {
            studentId,
            date,
            status,
            arrivedAt: arrivedAtFor(status, dateString),
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

    // Which cutoff applies depends on the student's own session (morning vs
    // afternoon), not the server's clock or a fixed cutoff for everyone.
    // Falls back to the "morning" cutoff for a student row that somehow has
    // no session set, matching the Session enum's own default.
    const student = await prisma.student.findUnique({
      where: { id: childId },
      select: { session: true },
    });
    const lateCutoffMinutes = LATE_CUTOFF_MINUTES[student?.session] ?? LATE_CUTOFF_MINUTES.morning;

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
    let lateArrivals = 0;

    const logs = records.map((r) => {
      const day = r.date.getUTCDate();
      daily[day] = r.status;

      if (r.status === "present") {
        presentDays += 1;
        // A manually-marked "present" with no arrivedAt (e.g. bulk entry)
        // has no arrival time to judge, so it's never counted as late.
        if (r.arrivedAt && schoolMinutesOfDay(r.arrivedAt) > lateCutoffMinutes) {
          lateArrivals += 1;
        }
      } else if (r.status === "absent") absentDays += 1;
      else if (r.status === "excused") excusedDays += 1;

      return {
        date: r.date.toLocaleDateString("en-US", {
          month: "short",
          day: "2-digit",
          year: "numeric",
        }),
        status: r.status,
        arrivedAt: r.arrivedAt,
        departedAt: r.departedAt,
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
        lateArrivals,
      },
      daily,
      logs,
    });
  } catch (err) {
    next(err);
  }
}
