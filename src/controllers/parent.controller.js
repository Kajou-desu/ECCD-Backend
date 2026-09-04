import { prisma } from "../lib/prisma.js";
import { assertCanAccessStudent } from "../utils/ownership.js";
import { parseId } from "../utils/validate.js";

// GET /api/parent/children — identity derived from JWT (req.user.id), never
// from client input.
export async function getChildren(req, res, next) {
  try {
    const links = await prisma.parentChild.findMany({
      where: { parentId: req.user.id },
      include: { student: true },
    });
    res.json(links.map((l) => l.student));
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
// `weeklyGoals` has no real data source: there is no teacher-facing UI or
// API anywhere (frontend or backend) to author curriculum goals for a
// child. Returning [] here rather than fabricating placeholder goals —
// building that out for real is a separate feature, not a wiring fix.
export async function getChildProgress(req, res, next) {
  try {
    const studentId = parseId(req.params.childId, "childId");
    await assertCanAccessStudent(req.user, studentId);

    const [attendanceRecords, submissions] = await Promise.all([
      prisma.attendance.findMany({ where: { studentId } }),
      prisma.submission.findMany({
        where: { studentId },
        include: { material: { select: { title: true, category: true } } },
        orderBy: { submittedAt: "desc" },
        take: 10,
      }),
    ]);

    const totalDays = attendanceRecords.length;
    const presentDays = attendanceRecords.filter((a) => a.status === "present").length;
    const attendancePct = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;

    const recentActivities = submissions.map((s) => ({
      id: s.id,
      date: s.submittedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      activity: s.material?.title ?? "Untitled activity",
      category: s.material?.category ?? "General",
      status: "completed",
      notes: "",
    }));

    res.json({
      milestones: submissions.length,
      attendance: `${attendancePct}%`,
      schoolDays: totalDays,
      activityCount: submissions.length,
      weeklyGoals: [],
      recentActivities,
    });
  } catch (err) {
    next(err);
  }
}
