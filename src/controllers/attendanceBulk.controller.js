import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/errorHandler.js";
import { assertCanAccessStudent } from "../utils/ownership.js";
import { parseId, requireDateString, requireAttendanceStatus } from "../utils/validate.js";
import { toDate, assertNotFutureDate, arrivedAtFor } from "./attendance.controller.js";

// Ranged reads and CSV import for attendance. Both are Teacher/Admin only
// (enforced at route level) and scoped the same way as the daily roster: a
// Teacher only ever sees or writes the students connected to them.

const MAX_RANGE_DAYS = 92; // a calendar quarter; keeps one response bounded
const MAX_RANGE_ROWS = 20000;
const MAX_IMPORT_ROWS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

const dayKey = (date) => date.toISOString().slice(0, 10);

function studentScope(user) {
  if (user.role === "Admin") return {};
  if (user.role === "Teacher") return { teacherId: user.id };
  throw new AppError("Forbidden", 403); // default deny
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
        departedAt: true,
        student: { select: { name: true, studentCode: true, session: true } },
      },
      orderBy: [{ date: "asc" }, { student: { name: "asc" } }],
      take: MAX_RANGE_ROWS + 1,
    });
    if (rows.length > MAX_RANGE_ROWS) {
      throw new AppError("Too many records in this range. Choose a shorter range.", 400);
    }

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
        departedAt: r.departedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/attendance/import  { records: [{ studentCode, date, status }], dryRun? }
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
        const code = typeof entry.studentCode === "string" ? entry.studentCode.trim() : "";
        if (!code || code.length > 50) throw new AppError("studentCode is required", 400);
        const dateString = requireDateString(entry.date);
        assertNotFutureDate(dateString);
        parsed.push({ row, code, dateString, date: toDate(dateString), status: requireAttendanceStatus(entry.status) });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        failed.push({ row, message: err.message });
      }
    });

    // Resolve codes inside the caller's own scope. A code that doesn't exist
    // and one belonging to another teacher get the same message, so this
    // can't be used to probe for students.
    const students = parsed.length
      ? await prisma.student.findMany({
          where: { studentCode: { in: [...new Set(parsed.map((p) => p.code))] }, ...scope },
          select: { id: true, studentCode: true },
        })
      : [];
    const idByCode = new Map(students.map((s) => [s.studentCode, s.id]));

    const valid = [];
    const firstRowFor = new Map();
    for (const entry of parsed) {
      const studentId = idByCode.get(entry.code);
      if (!studentId) {
        failed.push({ row: entry.row, message: `Student code "${entry.code}" was not found` });
        continue;
      }
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
            update: { status, arrivedAt: arrivedAtFor(status, dateString), departedAt: null },
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
