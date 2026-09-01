import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/errorHandler.js";

/**
 * Enforces that req.user may access data for `studentId`.
 * - TEACHER / ADMIN: full access (staff manage all students).
 * - PARENT: only if a ParentChild link exists for req.user.id.
 * Default is DENY — any unexpected role or missing link is forbidden.
 */
export async function assertCanAccessStudent(user, studentId) {
  if (user.role === "TEACHER" || user.role === "ADMIN") return;

  if (user.role === "PARENT") {
    const link = await prisma.parentChild.findUnique({
      where: { parentId_studentId: { parentId: user.id, studentId } },
    });
    if (link) return;
  }

  // Default deny
  throw new AppError("Forbidden", 403);
}
