import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/errorHandler.js";
import { optionalString, parseId, requireDateString, requireMonthString } from "../utils/validate.js";

// The most days one request can set (a whole school term of no-class days is
// never one request).
const MAX_RANGE_DAYS = 62;
const DAY_MS = 24 * 60 * 60 * 1000;

const dayKey = (date) => date.toISOString().slice(0, 10);
const toDate = (key) => new Date(`${key}T00:00:00.000Z`);

// Every weekday from..to inclusive. Saturdays and Sundays are skipped: they are
// not school days to begin with, so there is nothing to cancel.
export function weekdaysBetween(from, to) {
  const days = [];
  for (let t = toDate(from).getTime(); t <= toDate(to).getTime(); t += DAY_MS) {
    const date = new Date(t);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(date);
  }
  return days;
}

// GET /api/no-class-days?month=YYYY-MM — school-wide info like the events
// calendar, so Parents/Guardians may read it too (route level).
export async function listNoClassDays(req, res, next) {
  try {
    const month = requireMonthString(req.query.month);
    const [year, mon] = month.split("-").map(Number);
    const rows = await prisma.noClassDay.findMany({
      where: { date: { gte: new Date(Date.UTC(year, mon - 1, 1)), lt: new Date(Date.UTC(year, mon, 1)) } },
      select: { id: true, date: true, reason: true },
      orderBy: { date: "asc" },
    });
    res.json(rows.map((r) => ({ id: r.id, dateKey: dayKey(r.date), reason: r.reason })));
  } catch (err) {
    next(err);
  }
}

// POST /api/no-class-days  { from, to?, reason? } — Teacher/Admin only.
// Marks every weekday from..to (just `from` when `to` is left out) as no class.
// A day that is already marked is left as it is, so repeating a request is harmless.
export async function createNoClassDays(req, res, next) {
  try {
    const from = requireDateString(req.body?.from, "from");
    const to = req.body?.to === undefined || req.body?.to === null || req.body?.to === "" ? from : requireDateString(req.body.to, "to");
    if (from > to) throw new AppError("'from' must not be after 'to'", 400);
    if ((toDate(to) - toDate(from)) / DAY_MS + 1 > MAX_RANGE_DAYS) {
      throw new AppError(`Choose at most ${MAX_RANGE_DAYS} days at a time`, 400);
    }
    const reason = optionalString(req.body?.reason, 200);

    const days = weekdaysBetween(from, to);
    if (days.length === 0) {
      throw new AppError("Saturdays and Sundays are already not school days. Choose a weekday.", 400);
    }

    const { count } = await prisma.noClassDay.createMany({
      data: days.map((date) => ({ date, reason, createdById: req.user.id })),
      skipDuplicates: true,
    });

    res.status(201).json({ requested: days.length, created: count });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/no-class-days/:id — Teacher/Admin only. The day is a school day again.
export async function deleteNoClassDay(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    await prisma.noClassDay.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "That day was not found" });
    next(err);
  }
}
