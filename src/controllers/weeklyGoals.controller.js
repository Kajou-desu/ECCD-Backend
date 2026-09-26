import { prisma } from "../lib/prisma.js";
import {
  parseId,
  requireNonEmptyString,
  optionalString,
  requireSession,
  requireDateString,
  requireProgress,
} from "../utils/validate.js";
import { schoolWeekStart } from "../utils/schoolDate.js";
import { AppError } from "../middleware/errorHandler.js";

// Resolves a "?week=YYYY-MM-DD" query param (or a "weekStart" body field) to
// the Monday of that week, school-timezone. Defaults to the current week
// when omitted, so callers never have to compute a Monday themselves.
function resolveWeekStart(raw) {
  if (!raw) return schoolWeekStart();
  return schoolWeekStart(new Date(`${requireDateString(raw, "week")}T00:00:00.000Z`));
}

function toGoalResponse(goal) {
  return {
    id: goal.id,
    weekStart: goal.weekStart,
    session: goal.session,
    title: goal.title,
    description: goal.description,
    category: goal.category,
  };
}

// GET /api/weekly-goals?week=YYYY-MM-DD&session=morning
// Teacher/Admin only. Lists this week's goals for a session, each paired
// with every currently-enrolled student's progress (0/"Not started" for
// students with no progress row yet) — the shape the "grade the class" UI
// needs.
export async function getWeeklyGoals(req, res, next) {
  try {
    const weekStart = resolveWeekStart(req.query.week);
    const session = requireSession(req.query.session);

    const [goals, students] = await Promise.all([
      prisma.weeklyGoal.findMany({
        where: { weekStart, session },
        include: { progress: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.student.findMany({
        where: { session, status: "active" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);

    const result = goals.map((goal) => ({
      ...toGoalResponse(goal),
      students: students.map((student) => {
        const entry = goal.progress.find((p) => p.studentId === student.id);
        return {
          studentId: student.id,
          name: student.name,
          progress: entry?.progress ?? 0,
          status: entry?.status ?? "Not started",
        };
      }),
    }));

    res.json({ weekStart, session, goals: result });
  } catch (err) {
    next(err);
  }
}

// POST /api/weekly-goals — Teacher/Admin only.
export async function createWeeklyGoal(req, res, next) {
  try {
    const weekStart = resolveWeekStart(req.body.weekStart);
    const session = requireSession(req.body.session);
    const title = requireNonEmptyString(req.body.title, "title", 200);
    const description = optionalString(req.body.description, 2000);
    const category = optionalString(req.body.category, 100);

    const goal = await prisma.weeklyGoal.create({
      data: {
        weekStart,
        session,
        title,
        description,
        category,
        createdById: req.user.id,
      },
    });

    res.status(201).json(toGoalResponse(goal));
  } catch (err) {
    // Unique constraint on (weekStart, session, title): same wording as
    // events/materials duplicate-name handling elsewhere in this codebase.
    if (err.code === "P2002") {
      return res.status(409).json({ message: "A goal with this title already exists for that week and session" });
    }
    next(err);
  }
}

// PUT /api/weekly-goals/:id — Teacher/Admin only. Edits the goal itself
// (not per-student progress — see updateGoalProgress for that).
export async function updateWeeklyGoal(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    const { title, description, category } = req.body;

    const goal = await prisma.weeklyGoal.update({
      where: { id },
      data: {
        ...(title !== undefined && { title: requireNonEmptyString(title, "title", 200) }),
        ...(description !== undefined && { description: optionalString(description, 2000) }),
        ...(category !== undefined && { category: optionalString(category, 100) }),
      },
    });

    res.json(toGoalResponse(goal));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Goal not found" });
    if (err.code === "P2002") {
      return res.status(409).json({ message: "A goal with this title already exists for that week and session" });
    }
    next(err);
  }
}

// DELETE /api/weekly-goals/:id — Teacher/Admin only.
export async function deleteWeeklyGoal(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    await prisma.weeklyGoal.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Goal not found" });
    next(err);
  }
}

// PUT /api/weekly-goals/:id/progress — Teacher/Admin only. Upserts one or
// more students' progress against a single goal in one request, since a
// teacher realistically grades a whole session roster at once.
// Body: { updates: [{ studentId, progress, status }, ...] }
export async function updateGoalProgress(req, res, next) {
  try {
    const goalId = parseId(req.params.id, "id");
    const updates = req.body.updates;

    if (!Array.isArray(updates) || updates.length === 0) {
      throw new AppError("Invalid updates, expected a non-empty array", 400);
    }
    if (updates.length > 200) {
      throw new AppError("Too many updates in a single request", 400);
    }

    const parsed = updates.map((u) => ({
      studentId: parseId(u.studentId, "studentId"),
      progress: requireProgress(u.progress),
      status: requireNonEmptyString(u.status ?? "In progress", "status", 100),
    }));

    const goal = await prisma.weeklyGoal.findUnique({ where: { id: goalId }, select: { id: true } });
    if (!goal) return res.status(404).json({ message: "Goal not found" });

    const results = await prisma.$transaction(
      parsed.map((u) =>
        prisma.studentGoalProgress.upsert({
          where: { goalId_studentId: { goalId, studentId: u.studentId } },
          create: { goalId, studentId: u.studentId, progress: u.progress, status: u.status },
          update: { progress: u.progress, status: u.status },
        }),
      ),
    );

    res.json(
      results.map((r) => ({ studentId: r.studentId, progress: r.progress, status: r.status })),
    );
  } catch (err) {
    // A studentId that doesn't exist fails the FK constraint.
    if (err.code === "P2003") return res.status(400).json({ message: "Invalid studentId" });
    next(err);
  }
}
