import { prisma } from "../lib/prisma.js";
import { requireNonEmptyString, optionalString, requireStringArray, requireDateString } from "../utils/validate.js";
import { schoolDateAsUtcMidnight } from "../utils/schoolDate.js";

export async function getDashboardStats(_req, res, next) {
  try {
    const today = new Date();
    const todayDate = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));

    const [totalStudents, presentToday, absentToday, totalMaterials] = await Promise.all([
      prisma.student.count(),
      prisma.attendance.count({ where: { date: todayDate, status: "present" } }),
      prisma.attendance.count({ where: { date: todayDate, status: "absent" } }),
      prisma.material.count(),
    ]);

    res.json({ totalStudents, presentToday, absentToday, totalMaterials });
  } catch (err) {
    next(err);
  }
}

export async function getDailyTheme(_req, res, next) {
  try {
    const today = new Date();
    const todayDate = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));

    const theme = await prisma.dailyTheme.findUnique({ where: { date: todayDate } });

    if (!theme) {
      // DailyThemeCard.jsx renders theme.title/description/objectives directly
      // and calls .map() on objectives — never return null/undefined fields.
      return res.json({
        letter: "",
        label: "",
        subtitle: "",
        title: "No theme set for today",
        description: "",
        objectives: [],
      });
    }

    res.json(theme);
  } catch (err) {
    next(err);
  }
}

// PUT /api/dashboard/daily-theme — Teacher/Admin only. Creates today's
// theme (or the given `date`) if none exists yet, otherwise edits it in
// place. There was previously no way to author a theme at all short of a
// direct DB insert.
export async function upsertDailyTheme(req, res, next) {
  try {
    const date = req.body.date
      ? new Date(`${requireDateString(req.body.date)}T00:00:00.000Z`)
      : schoolDateAsUtcMidnight();

    const data = {
      letter: requireNonEmptyString(req.body.letter, "letter", 10),
      label: requireNonEmptyString(req.body.label, "label", 100),
      subtitle: optionalString(req.body.subtitle, 200),
      title: requireNonEmptyString(req.body.title, "title", 200),
      description: optionalString(req.body.description, 2000),
      objectives: requireStringArray(req.body.objectives ?? [], "objectives"),
    };

    const theme = await prisma.dailyTheme.upsert({
      where: { date },
      create: { date, ...data },
      update: data,
    });

    res.json(theme);
  } catch (err) {
    next(err);
  }
}
