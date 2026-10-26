import { prisma } from "../lib/prisma.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { requireNonEmptyString, optionalString, requireStringArray, requireDateString, parseId } from "../utils/validate.js";
import { schoolDateAsUtcMidnight } from "../utils/schoolDate.js";
import { studentScopeFor } from "../utils/ownership.js";
import { contentScopeFor, staffContentScopeFor, inContentScope } from "../utils/contentScope.js";

// The numbers cover the students and materials the user can see: a Teacher's
// whole center (teachers at one center share their data), an Admin's everyone.
// Anyone else gets nothing (default deny — the route also limits it to these two roles).
export async function getDashboardStats(req, res, next) {
  try {
    // School-local day, not the server's: the server runs in UTC, so using
    // its local date left the counts on "yesterday" until 8 AM Manila time.
    const todayDate = schoolDateAsUtcMidnight();
    const scope = studentScopeFor(req.user);
    if (!scope) return res.status(403).json({ message: "Forbidden" });
    const studentFilter = { student: scope };
    // A Teacher with no center yet sees no materials (see contentScopeFor).
    const materialScope = contentScopeFor(req.user);

    const [totalStudents, presentToday, absentToday, totalMaterials] = await Promise.all([
      prisma.student.count({ where: scope }),
      prisma.attendance.count({ where: { date: todayDate, status: "present", ...studentFilter } }),
      prisma.attendance.count({ where: { date: todayDate, status: "absent", ...studentFilter } }),
      materialScope ? prisma.material.count({ where: materialScope }) : 0,
    ]);

    res.json({ totalStudents, presentToday, absentToday, totalMaterials });
  } catch (err) {
    next(err);
  }
}

// The theme itself is school-wide (one per day), but the activity attached to it
// belongs to a center: it is only shown to a caller who may see that center's
// materials, so a theme can't be used to read another center's file.
export async function getDailyTheme(req, res, next) {
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
      material: inContentScope(contentScopeFor(req.user), theme.material)
        ? { ...theme.material, fileUrl: signFileUrl(req, theme.material.fileUrl) }
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

    // The attached activity must be one of the caller's own center's (an Admin: any).
    if (data.materialId !== null) {
      const scope = staffContentScopeFor(req.user);
      const material = await prisma.material.findUnique({
        where: { id: data.materialId, ...scope },
        select: { id: true },
      });
      if (!material) return res.status(400).json({ message: "Material not found" });
    }

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
