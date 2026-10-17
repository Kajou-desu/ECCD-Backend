import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";
import { optionalString, parseId, requireDateString } from "../utils/validate.js";
import { schoolDateString, schoolMinutesOfDay } from "../utils/schoolDate.js";
import { ACTIVITY_CATEGORIES, recordActivity } from "../services/activityLog.service.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

// The instant a school-calendar day ("YYYY-MM-DD") starts, in the school's
// timezone — so "from 2026-10-12" means 12 October Manila time, not UTC.
export function schoolDayStart(key, timeZone = env.schoolTimezone) {
  const guess = new Date(`${key}T00:00:00.000Z`);
  const minutes = schoolMinutesOfDay(guess, timeZone);
  // The zone is ahead of UTC when the same calendar day is already running at
  // 00:00Z, behind it when it is still the day before.
  return schoolDateString(guess, timeZone) === key
    ? new Date(guess.getTime() - minutes * 60_000)
    : new Date(guess.getTime() + (24 * 60 - minutes) * 60_000);
}

function pageParams(query) {
  const page = query.page === undefined ? 1 : parseId(query.page, "page");
  const pageSize = query.pageSize === undefined ? DEFAULT_PAGE_SIZE : parseId(query.pageSize, "pageSize");
  if (pageSize > MAX_PAGE_SIZE) throw new AppError(`pageSize must be ${MAX_PAGE_SIZE} or less`, 400);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

// GET /api/activity-logs — Admin only (route level), newest first.
//   ?category=student   one of ACTIVITY_CATEGORIES
//   ?actorId=5          one account
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD   school days, both inclusive
//   ?q=text             contains, in the summary or the actor's email
//   ?page=1&pageSize=50
export async function listActivityLogs(req, res, next) {
  try {
    const { page, pageSize, skip } = pageParams(req.query);
    const where = {};

    if (req.query.category !== undefined && req.query.category !== "") {
      if (!ACTIVITY_CATEGORIES.includes(req.query.category)) {
        throw new AppError(`Invalid category, expected one of: ${ACTIVITY_CATEGORIES.join(", ")}`, 400);
      }
      where.action = { startsWith: `${req.query.category}.` };
    }
    if (req.query.actorId !== undefined && req.query.actorId !== "") {
      where.actorId = parseId(req.query.actorId, "actorId");
    }
    const from = req.query.from ? requireDateString(req.query.from, "from") : null;
    const to = req.query.to ? requireDateString(req.query.to, "to") : null;
    if (from && to && from > to) throw new AppError("'from' must not be after 'to'", 400);
    if (from || to) {
      where.createdAt = {
        ...(from && { gte: schoolDayStart(from) }),
        // end of the `to` day = start of the next one
        ...(to && { lt: new Date(schoolDayStart(to).getTime() + DAY_MS) }),
      };
    }
    const q = optionalString(req.query.q, 100);
    if (q) {
      where.OR = [
        { summary: { contains: q, mode: "insensitive" } },
        { actorEmail: { contains: q, mode: "insensitive" } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: pageSize,
        select: {
          id: true,
          createdAt: true,
          actorId: true,
          actorEmail: true,
          actorRole: true,
          action: true,
          targetType: true,
          targetId: true,
          summary: true,
        },
      }),
      prisma.activityLog.count({ where }),
    ]);

    res.json({ logs: rows, total, page, pageSize });
  } catch (err) {
    next(err);
  }
}

// What the browser can export. The files are built in the browser, so the
// server can't see them: this is the browser reporting that an export
// happened. It is useful as a trail, not proof (a client could skip the call).
export const EXPORT_KINDS = {
  students: "Student list",
  student_profile: "Student profile",
  attendance: "Daily attendance",
  attendance_range: "Attendance (week/month/student)",
  parent_attendance: "Child attendance logs",
};

// POST /api/activity-logs/export  { kind, rows? } — any signed-in user.
export async function recordExport(req, res, next) {
  try {
    const label = EXPORT_KINDS[req.body?.kind];
    if (!label) throw new AppError(`Invalid kind, expected one of: ${Object.keys(EXPORT_KINDS).join(", ")}`, 400);

    let rows = null;
    if (req.body.rows !== undefined && req.body.rows !== null) {
      rows = req.body.rows;
      if (!Number.isInteger(rows) || rows < 0 || rows > 1_000_000) throw new AppError("Invalid rows", 400);
    }

    await recordActivity({
      actor: req.user,
      action: "export.csv",
      summary: `Exported ${label}${rows === null ? "" : ` (${rows} row${rows === 1 ? "" : "s"})`}`,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
