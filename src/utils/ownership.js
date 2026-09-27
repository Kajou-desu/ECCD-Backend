import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/errorHandler.js";

/**
 * Enforces that req.user may access data for `studentId`.
 * - Admin: full access (manages every student).
 * - Teacher: only the student connected to them (Student.teacherId).
 * - Parent / Guardian: only if a ParentChild link exists for req.user.id.
 *   (Guardian is treated identically to Parent here, matching the
 *   frontend's isParent() helper in src/auth/permissions.js.)
 * Default is DENY — any unexpected role, missing link, or missing/
 * unassigned student is forbidden. A student that doesn't exist and one
 * that exists but isn't this teacher's are deliberately indistinguishable
 * here (both 403), so this never leaks whether a given id is valid.
 */
export async function assertCanAccessStudent(user, studentId) {
  if (user.role === "Admin") return;

  if (user.role === "Teacher") {
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: { teacherId: true },
    });
    if (student && student.teacherId === user.id) return;
  }

  if (user.role === "Parent" || user.role === "Guardian") {
    const link = await prisma.parentChild.findUnique({
      where: { parentId_studentId: { parentId: user.id, studentId } },
    });
    if (link) return;
  }

  // Default deny
  throw new AppError("Forbidden", 403);
}
