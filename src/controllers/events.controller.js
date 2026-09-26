import { prisma } from "../lib/prisma.js";
import {
  requireMonthString,
  requireDateString,
  requireNonEmptyString,
  optionalString,
  parseId,
} from "../utils/validate.js";
import { AppError } from "../middleware/errorHandler.js";

const EVENT_CATEGORIES = ["Holiday", "Birthday", "Event", "Others"];

function requireEventCategory(value) {
  if (!EVENT_CATEGORIES.includes(value)) {
    throw new AppError(`Invalid category, expected one of: ${EVENT_CATEGORIES.join(", ")}`, 400);
  }
  return value;
}

// GET /api/events?month=YYYY-MM
// CalendarEvents.jsx does NOT consume a raw array — verified against actual
// component logic (getDayColor, eventLogs) and EVENTS_DATA in mockData.js:
//   daily: { [dayOfMonth]: "Holiday" | "Birthday" | "Event" }  (compared
//     directly, no normalization — must match these exact strings)
//   logs:  [{ date, time, status }]  (status is normalized client-side via
//     normalizeEventLegend(), so any reasonably descriptive string works)
export async function getEvents(req, res, next) {
  try {
    const month = requireMonthString(req.query.month);
    const [year, mon] = month.split("-").map(Number);
    const start = new Date(Date.UTC(year, mon - 1, 1));
    const end = new Date(Date.UTC(year, mon, 1));

    const events = await prisma.event.findMany({
      where: { date: { gte: start, lt: end } },
      orderBy: { date: "asc" },
    });

    const daily = {};
    const logs = events.map((e) => {
      const day = e.date.getUTCDate();
      const category = e.category === "Others" ? "Event" : e.category;
      daily[day] = category;

      return {
        id: e.id,
        title: e.title,
        description: e.description,
        dateKey: e.date.toISOString().slice(0, 10),
        date: e.date.toLocaleDateString("en-US", {
          month: "short",
          day: "2-digit",
          year: "numeric",
        }),
        time: "---",
        status: category,
      };
    });

    res.json({ daily, logs });
  } catch (err) {
    next(err);
  }
}

// POST /api/events — Teacher/Admin only (enforced at route level).
export async function createEvent(req, res, next) {
  try {
    const title = requireNonEmptyString(req.body.title, "title", 200);
    const dateString = requireDateString(req.body.date, "date");
    const category = requireEventCategory(req.body.category);
    const description = optionalString(req.body.description, 1000);

    const [year, month, day] = dateString.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    const event = await prisma.event.create({
      data: { title, date, category, description },
    });

    res.status(201).json(event);
  } catch (err) {
    next(err);
  }
}

export async function updateEvent(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    const title = requireNonEmptyString(req.body.title, "title", 200);
    const dateString = requireDateString(req.body.date, "date");
    const category = requireEventCategory(req.body.category);
    const description = optionalString(req.body.description, 1000);
    const [year, month, day] = dateString.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    const event = await prisma.event.update({
      where: { id },
      data: { title, date, category, description },
    });

    res.json(event);
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Event not found" });
    next(err);
  }
}

export async function deleteEvent(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    await prisma.event.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Event not found" });
    next(err);
  }
}
