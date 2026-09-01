import { prisma } from "../lib/prisma.js";
import { assertCanAccessStudent } from "../utils/ownership.js";
import {
  parseId,
  requireDateString,
  requireMonthString,
  requireAttendanceStatus,
} from "../utils/validate.js";

function toDate(dateString) {
  return new Date(`${dateString}T00:00:00.000Z`);
}

// Teacher/admin only (enforced at route level) — full roster view.
export async function getAttendance(req, res, next) {
  try {
    const date = requireDateString(req.query.date);
    const records = await prisma.attendance.findMany({
      where: { date: toDate(date) },
      include: { student: { select: { id: true, name: true, classroom: true } } },
    });
    res.json(records);
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
      update: { status },
      create: { studentId, date: toDate(date), status },
    });
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
          update: { status },
          create: { studentId, date, status },
        })
      )
    );
    res.status(201).json(results);
  } catch (err) {
    next(err);
  }
}

// GET /api/students/:childId/attendance?month=YYYY-MM
// Any authenticated role may call this; PARENT is restricted to their own children.
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
    res.json(records);
  } catch (err) {
    next(err);
  }
}
