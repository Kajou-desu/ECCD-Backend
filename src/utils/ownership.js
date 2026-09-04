import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/errorHandler.js";

/**
 * Enforces that req.user may access data for `studentId`.
 * - Teacher / Admin: full access (staff manage all students).
 * - Parent / Guardian: only if a ParentChild link exists for req.user.id.
 *   (Guardian is treated identically to Parent here, matching the
 *   frontend's isParent() helper in src/auth/permissions.js.)
 * Default is DENY — any unexpected role or missing link is forbidden.
 */
export async function assertCanAccessStudent(user, studentId) {
  if (user.role === "Teacher" || user.role === "Admin") return;

  if (user.role === "Parent" || user.role === "Guardian") {
    const link = await prisma.parentChild.findUnique({
      where: { parentId_studentId: { parentId: user.id, studentId } },
    });
    if (link) return;
  }

  // Default deny
  throw new AppError("Forbidden", 403);
}
