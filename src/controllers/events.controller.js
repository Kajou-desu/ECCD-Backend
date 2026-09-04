import { prisma } from "../lib/prisma.js";
import { requireMonthString } from "../utils/validate.js";

// GET /api/events?month=YYYY-MM
// CalendarEvents.jsx does NOT consume a raw array — verified against actual
// component logic (getDayColor, eventLogs) and EVENTS_DATA in mockData.js:
//   daily: { [dayOfMonth]: "Holiday" | "Birthday" | "Others" }  (compared
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
      daily[day] = e.category;

      return {
        date: e.date.toLocaleDateString("en-US", {
          month: "short",
          day: "2-digit",
          year: "numeric",
        }),
        time: "---",
        status: e.category,
      };
    });

    res.json({ daily, logs });
  } catch (err) {
    next(err);
  }
}
