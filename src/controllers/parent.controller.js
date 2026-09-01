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
// PARENT may only view their own child's progress.
export async function getChildProgress(req, res, next) {
  try {
    const studentId = parseId(req.params.childId, "childId");
    await assertCanAccessStudent(req.user, studentId);

    const [totalMaterials, completedSubmissions, attendanceCounts] = await Promise.all([
      prisma.material.count(),
      prisma.submission.count({ where: { studentId } }),
      prisma.attendance.groupBy({
        by: ["status"],
        where: { studentId },
        _count: { status: true },
      }),
    ]);

    res.json({
      studentId,
      materialsCompleted: completedSubmissions,
      materialsTotal: totalMaterials,
      attendance: Object.fromEntries(
        attendanceCounts.map((a) => [a.status, a._count.status])
      ),
    });
  } catch (err) {
    next(err);
  }
}
