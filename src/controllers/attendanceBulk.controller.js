import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/errorHandler.js";
import { assertCanAccessStudent, assertCanAccessStudents, studentScopeFor } from "../utils/ownership.js";
import { parseId, requireDateString, requireAttendanceStatus } from "../utils/validate.js";
import { toDate, assertNotFutureDate, arrivedAtFor } from "./attendance.controller.js";
import { isLateArrival } from "../utils/late.js";
import { loadSchoolTimes, schoolTimesFor } from "../lib/schoolTimes.js";

// Ranged reads, CSV import and deletion for attendance. All are Teacher/Admin
// only (enforced at route level) and scoped the same way as the daily roster: a
// Teacher only ever sees or writes the students connected to them.

const MAX_RANGE_DAYS = 92; // a calendar quarter; keeps one response bounded
const MAX_RANGE_ROWS = 20000;
const MAX_IMPORT_ROWS = 500;
const MAX_NAME_LENGTH = 200;
const MAX_DELETE_STUDENTS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const dayKey = (date) => date.toISOString().slice(0, 10);

// How a CSV name is compared with a student's name: ignoring case, extra spaces
// and how an accent was typed ("José" as one character or as e + accent).
const nameKey = (name) => name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

function studentScope(user) {
  const scope = studentScopeFor(user);
  if (!scope) throw new AppError("Forbidden", 403); // default deny
  return scope;
}

// GET /api/attendance/range?from=YYYY-MM-DD&to=YYYY-MM-DD[&studentId=N]
// One query for a whole week/month export. Only days that were actually
// recorded are returned: the system has no school calendar, so a day with no
// record can't be told apart from a holiday.
export async function getAttendanceRange(req, res, next) {
  try {
    const scope = studentScope(req.user);
    const from = requireDateString(req.query.from, "from");
    const to = requireDateString(req.query.to, "to");
    if (from > to) throw new AppError("'from' must not be after 'to'", 400);
    const days = Math.round((toDate(to) - toDate(from)) / DAY_MS) + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new AppError(`The date range can be at most ${MAX_RANGE_DAYS} days`, 400);
    }

    let studentFilter = scope;
    if (req.query.studentId !== undefined) {
      const studentId = parseId(req.query.studentId, "studentId");
      await assertCanAccessStudent(req.user, studentId);
      studentFilter = { id: studentId };
    }

    const rows = await prisma.attendance.findMany({
      where: { date: { gte: toDate(from), lte: toDate(to) }, student: studentFilter },
      select: {
        studentId: true,
        date: true,
        status: true,
        arrivedAt: true,
        pickedUpAt: true,
        student: {
          select: { name: true, studentCode: true, session: true, teacher: { select: { centerId: true } } },
        },
      },
      orderBy: [{ date: "asc" }, { student: { name: "asc" } }],
      take: MAX_RANGE_ROWS + 1,
    });
    if (rows.length > MAX_RANGE_ROWS) {
      throw new AppError("Too many records in this range. Choose a shorter range.", 400);
    }

    // Late is judged against each student's own center's school times.
    const schoolTimes = await loadSchoolTimes(rows.map((r) => r.student.teacher?.centerId));

    res.json({
      from,
      to,
      records: rows.map((r) => ({
        studentId: r.studentId,
        studentCode: r.student.studentCode,
        name: r.student.name,
        session: r.student.session,
        date: dayKey(r.date),
        status: r.status,
        arrivedAt: r.arrivedAt,
        pickedUpAt: r.pickedUpAt,
        late: isLateArrival(
          r.status,
          r.arrivedAt,
          r.student.session,
          schoolTimesFor(schoolTimes, r.student.teacher?.centerId),
        ),
      })),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/attendance/import  { records: [{ studentName, date, status }], dryRun? }
// `date` is YYYY-MM-DD here: the app turns the CSV's MM/DD/YYYY into that before
// sending. Students are matched by their full name (ignoring case and extra
// spaces) among the caller's own students. A name that matches more than one of
// them can't be told apart, so that row fails rather than guessing.
// Rows are checked one by one and reported by row number (the CSV's header is
// row 1, so the first record is row 2). A bad row is skipped, not fatal.
// Re-importing the same file is harmless: a record whose status already
// matches is "unchanged" and left untouched (so a face/BLE-verified present
// keeps its arrival time and verification).
export async function importAttendance(req, res, next) {
  try {
    const scope = studentScope(req.user);
    const records = req.body?.records;
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ message: "No attendance records supplied" });
    }
    if (records.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({ message: `A maximum of ${MAX_IMPORT_ROWS} records can be imported at once` });
    }
    const dryRun = req.body.dryRun === true;

    const failed = [];
    const parsed = [];
    records.forEach((entry, index) => {
      const row = index + 2;
      try {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          throw new AppError("Invalid record", 400);
        }
        const name = typeof entry.studentName === "string" ? entry.studentName.trim() : "";
        if (!name || name.length > MAX_NAME_LENGTH) throw new AppError("Student Name is required", 400);
        const dateString = requireDateString(entry.date);
        assertNotFutureDate(dateString);
        parsed.push({ row, name, dateString, date: toDate(dateString), status: requireAttendanceStatus(entry.status) });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        failed.push({ row, message: err.message });
      }
    });

    // Resolve names inside the caller's own scope. A name that doesn't exist
    // and one belonging to another teacher's student get the same message, so
    // this can't be used to probe for students. Several students in scope can
    // share a name; those rows are refused rather than attached to one of them.
    const students = parsed.length
      ? await prisma.student.findMany({ where: scope, select: { id: true, name: true } })
      : [];
    const idsByName = new Map();
    for (const s of students) {
      const key = nameKey(s.name);
      idsByName.set(key, [...(idsByName.get(key) ?? []), s.id]);
    }

    const valid = [];
    const firstRowFor = new Map();
    for (const entry of parsed) {
      const matches = idsByName.get(nameKey(entry.name)) ?? [];
      if (matches.length === 0) {
        failed.push({ row: entry.row, message: `Student "${entry.name}" was not found` });
        continue;
      }
      if (matches.length > 1) {
        failed.push({
          row: entry.row,
          message: `${matches.length} students are named "${entry.name}", so this row can't be matched. Mark them by hand.`,
        });
        continue;
      }
      const studentId = matches[0];
      const key = `${studentId}:${entry.dateString}`;
      if (firstRowFor.has(key)) {
        failed.push({ row: entry.row, message: `Duplicate of row ${firstRowFor.get(key)} (same student and date)` });
        continue;
      }
      firstRowFor.set(key, entry.row);
      valid.push({ ...entry, studentId });
    }

    const existing = valid.length
      ? await prisma.attendance.findMany({
          where: { OR: valid.map(({ studentId, date }) => ({ studentId, date })) },
          select: { studentId: true, date: true, status: true },
        })
      : [];
    const existingStatus = new Map(existing.map((r) => [`${r.studentId}:${dayKey(r.date)}`, r.status]));
    const toWrite = valid.filter((e) => existingStatus.get(`${e.studentId}:${e.dateString}`) !== e.status);
    const created = toWrite.filter((e) => !existingStatus.has(`${e.studentId}:${e.dateString}`)).length;
    const summary = { created, updated: toWrite.length - created, unchanged: valid.length - toWrite.length };

    failed.sort((a, b) => a.row - b.row);
    if (dryRun) return res.json({ dryRun: true, ...summary, failed });

    if (toWrite.length) {
      const written = await prisma.$transaction(
        toWrite.map(({ studentId, date, dateString, status }) =>
          prisma.attendance.upsert({
            where: { studentId_date: { studentId, date } },
            update: { status, arrivedAt: arrivedAtFor(status, dateString), pickedUpAt: null, pickedUpAuto: false },
            create: { studentId, date, status, arrivedAt: arrivedAtFor(status, dateString) },
          }),
        ),
      );
      // A manual edit supersedes any automatic evidence for what changed.
      await prisma.attendanceVerification.deleteMany({
        where: { attendanceId: { in: written.map((r) => r.id) } },
      });
    }
    res.json({ dryRun: false, ...summary, failed });
  } catch (err) {
    next(err);
  }
}

// POST /api/attendance/delete
//   { from, to?, studentIds: [1, 2] | allStudents: true, dryRun? }
// Deletes attendance records for one student, several, or all of the caller's
// students, for one day (`to` omitted) or a range of at most MAX_RANGE_DAYS.
// Exactly one of studentIds / allStudents must be given, so a request can never
// widen to "everyone" by accident. "All" means everyone the caller may see: a
// Teacher's center, or every student for an Admin. With dryRun the matching
// records are only counted, so the app can say what it is about to delete.
// A record's face/BLE verification goes with it (cascade). Parents are not told.
export async function deleteAttendance(req, res, next) {
  try {
    const scope = studentScope(req.user);
    const body = req.body ?? {};

    const from = requireDateString(body.from, "from");
    const to = body.to === undefined ? from : requireDateString(body.to, "to");
    if (from > to) throw new AppError("'from' must not be after 'to'", 400);
    const days = Math.round((toDate(to) - toDate(from)) / DAY_MS) + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new AppError(`The date range can be at most ${MAX_RANGE_DAYS} days`, 400);
    }

    const byIds = body.studentIds !== undefined;
    const everyone = body.allStudents === true;
    if (byIds === everyone) {
      throw new AppError("Choose the students with either studentIds or allStudents", 400);
    }

    let studentFilter = scope;
    if (byIds) {
      if (
        !Array.isArray(body.studentIds) ||
        body.studentIds.length === 0 ||
        body.studentIds.length > MAX_DELETE_STUDENTS
      ) {
        throw new AppError(`studentIds must list between 1 and ${MAX_DELETE_STUDENTS} students`, 400);
      }
      const ids = [...new Set(body.studentIds.map((id) => parseId(id, "studentId")))];
      // All-or-nothing: one student outside the caller's scope forbids the lot.
      await assertCanAccessStudents(req.user, ids);
      // The scope is applied again below, so the delete is bounded by it even if
      // the check above were ever loosened.
      studentFilter = { id: { in: ids }, ...scope };
    }

    const where = { date: { gte: toDate(from), lte: toDate(to) }, student: studentFilter };

    if (body.dryRun === true) {
      return res.json({ dryRun: true, wouldDelete: await prisma.attendance.count({ where }) });
    }
    const { count } = await prisma.attendance.deleteMany({ where });
    res.json({ dryRun: false, deleted: count });
  } catch (err) {
    next(err);
  }
}
