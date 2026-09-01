import { prisma } from "../lib/prisma.js";

// GET /api/events?month=YYYY-MM
export async function getEvents(req, res, next) {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ message: "month query param required" });

    const [year, mon] = String(month).split("-").map(Number);
    const start = new Date(Date.UTC(year, mon - 1, 1));
    const end = new Date(Date.UTC(year, mon, 1));

    const events = await prisma.event.findMany({
      where: { date: { gte: start, lt: end } },
      orderBy: { date: "asc" },
    });
    res.json(events);
  } catch (err) {
    next(err);
  }
}
