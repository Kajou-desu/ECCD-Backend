import { prisma } from "../lib/prisma.js";
import { assertCanAccessStudent } from "../utils/ownership.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { parseId } from "../utils/validate.js";
import { schoolWeekStart } from "../utils/schoolDate.js";

// GET /api/parent/children — identity derived from JWT (req.user.id), never
// from client input.
export async function getChildren(req, res, next) {
  try {
    const links = await prisma.parentChild.findMany({
      where: { parentId: req.user.id },
      include: { student: { include: { teacher: { select: { name: true } } } } },
    });
    res.json(
      links.map((l) => {
        const { teacher, ...student } = l.student;
        return { ...student, teacher: teacher?.name ?? null, photo: signFileUrl(req, student.photo) };
      })
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
export async function getChildProgress(req, res, next) {
  try {
    const studentId = parseId(req.params.childId, "childId");
    await assertCanAccessStudent(req.user, studentId);

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: { session: true },
    });
    if (!student) return res.status(404).json({ message: "Student not found" });

    const [attendanceRecords, submissions, goals] = await Promise.all([
      prisma.attendance.findMany({ where: { studentId } }),
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
    ]);

    const weeklyGoals = goals.map((g) => ({
      id: g.id,
      title: g.title,
      progress: g.progress[0]?.progress ?? 0,
      status: g.progress[0]?.status ?? "Not started",
    }));

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
      weeklyGoals,
      recentActivities,
    });
  } catch (err) {
    next(err);
  }
}
