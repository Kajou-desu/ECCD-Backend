import { prisma } from "../lib/prisma.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { requireNonEmptyString, optionalString, requireStringArray, requireDateString, parseId } from "../utils/validate.js";
import { schoolDateAsUtcMidnight } from "../utils/schoolDate.js";

export async function getDashboardStats(_req, res, next) {
  try {
    // School-local day, not the server's: the server runs in UTC, so using
    // its local date left the counts on "yesterday" until 8 AM Manila time.
    const todayDate = schoolDateAsUtcMidnight();

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
    const todayDate = schoolDateAsUtcMidnight();

    const theme = await prisma.dailyTheme.findUnique({
      where: { date: todayDate },
      include: { material: true },
    });

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

    res.json({
      ...theme,
      material: theme.material
        ? { ...theme.material, fileUrl: signFileUrl(_req, theme.material.fileUrl) }
        : null,
    });
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
      // Only an absent/null/blank materialId means "no material". Anything
      // else (including 0) must be a real id — falsy-checking silently turned
      // 0 into "no material".
      materialId: [undefined, null, ""].includes(req.body.materialId)
        ? null
        : parseId(req.body.materialId, "materialId"),
    };

    const theme = await prisma.dailyTheme.upsert({
      where: { date },
      create: { date, ...data },
      update: data,
    });

    res.json(theme);
  } catch (err) {
    // materialId that doesn't exist fails the foreign-key constraint.
    if (err.code === "P2003") return res.status(400).json({ message: "Material not found" });
    next(err);
  }
}
