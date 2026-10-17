import { prisma } from "../lib/prisma.js";
import { assertCanAccessStudent } from "../utils/ownership.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { parseId } from "../utils/validate.js";
import { schoolWeekStart } from "../utils/schoolDate.js";

// How many milestones the dashboard lists; the count above it is the full total.
const MILESTONE_LIST_LIMIT = 50;

// GET /api/parent/children — identity derived from JWT (req.user.id), never
// from client input.
export async function getChildren(req, res, next) {
  try {
    const links = await prisma.parentChild.findMany({
      where: { parentId: req.user.id },
      include: { student: { include: { teacher: { select: { name: true } } } } },
    });
    res.json(
      links
        .map((l) => {
          if (!l.student) return null;
          const { teacher, ...student } = l.student;
          return { ...student, teacher: teacher?.name ?? null, photo: signFileUrl(req, student.photo) };
        })
        .filter(Boolean)
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/students/:childId/progress
// Parent/Guardian may only view their own child's progress.
//
// Verified against actual ParentDashboard.jsx usage (progress.milestones,
// progress.attendance, progress.schoolDays, progress.activityCount,
// progress.weeklyGoals -> WeeklyGoalsCard, progress.recentActivities ->
// RecentActivitiesCard), not the {materialsCompleted, materialsTotal,
// attendance: {...}} shape this originally guessed.
//
// weeklyGoals: real data, per docs/WEEKLY_GOALS_PROPOSAL.md — this week's
// classroom goals for the child's session, with the child's own progress
// row (defaulting to 0%/"Not started" when the teacher hasn't graded yet).
// A goal the child has completed (100%) moves out of this list and into the
// milestones, so it is never shown in both. weeklyGoalsTotal is the number of
// goals this week before that, so the page can say "all achieved" instead of
// looking like no goals were set.
//
// milestones / milestoneList: every goal the child has completed (progress
// 100), newest week first. No extra table: a milestone is simply a completed
// StudentGoalProgress row, dated by the week of its goal (the row's own
// updatedAt moves whenever a teacher re-grades, so it isn't a stable date).
export async function getChildProgress(req, res, next) {
  try {
    const studentId = parseId(req.params.childId, "childId");
    await assertCanAccessStudent(req.user, studentId);

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: { session: true },
    });
    if (!student) return res.status(404).json({ message: "Student not found" });

    const [totalDays, presentDays, submissions, goals, milestones, milestoneRows] = await Promise.all([
      // Counted in the database: a child's whole attendance history grows every
      // school day and only these two numbers are needed from it.
      prisma.attendance.count({ where: { studentId } }),
      prisma.attendance.count({ where: { studentId, status: "present" } }),
      prisma.submission.findMany({
        where: { studentId },
        include: { material: { select: { title: true, category: true } } },
        orderBy: { submittedAt: "desc" },
        take: 10,
      }),
      prisma.weeklyGoal.findMany({
        where: { weekStart: schoolWeekStart(), session: student.session },
        include: { progress: { where: { studentId } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.studentGoalProgress.count({ where: { studentId, progress: 100 } }),
      prisma.studentGoalProgress.findMany({
        where: { studentId, progress: 100 },
        select: { id: true, goal: { select: { title: true, category: true, weekStart: true } } },
        orderBy: [{ goal: { weekStart: "desc" } }, { updatedAt: "desc" }],
        take: MILESTONE_LIST_LIMIT,
      }),
    ]);

    const allGoals = goals.map((g) => ({
      id: g.id,
      title: g.title,
      progress: g.progress[0]?.progress ?? 0,
      status: g.progress[0]?.status ?? "Not started",
    }));
    const weeklyGoals = allGoals.filter((g) => g.progress < 100);

    const milestoneList = milestoneRows.map((m) => ({
      id: m.id,
      title: m.goal.title,
      category: m.goal.category,
      weekStart: m.goal.weekStart.toISOString().slice(0, 10),
    }));

    const attendancePct = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;

    const recentActivities = submissions.map((s) => ({
      id: s.id,
      date: s.submittedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      activity: s.material?.title ?? "Untitled activity",
      category: s.material?.category ?? "General",
      status: "completed",
      submittedAt: s.submittedAt.toISOString(),
      // Short-lived signed URL, same mechanism as the submissions endpoint.
      fileUrl: signFileUrl(req, s.fileUrl),
    }));

    res.json({
      milestones,
      milestoneList,
      attendance: `${attendancePct}%`,
      schoolDays: totalDays,
      activityCount: submissions.length,
      weeklyGoals,
      weeklyGoalsTotal: allGoals.length,
      recentActivities,
    });
  } catch (err) {
    next(err);
  }
}
