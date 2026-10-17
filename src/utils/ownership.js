import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/errorHandler.js";

/**
 * Which students a Teacher/Admin may work with, as a Prisma `where` for Student
 * (use it as `{ student: scope }` on tables that point at a student).
 * - Admin: everyone.
 * - Teacher: every student whose teacher is at the Teacher's own center — a
 *   center's data is shared by its teachers, not split per teacher. A Teacher
 *   with no center yet falls back to their own students only.
 * - Anyone else: null (deny). Callers must refuse on null, never default to all.
 */
export function studentScopeFor(user) {
  if (user?.role === "Admin") return {};
  if (user?.role === "Teacher") {
    return user.centerId != null ? { teacher: { centerId: user.centerId } } : { teacherId: user.id };
  }
  return null;
}

/**
 * Enforces that req.user may access data for `studentId`.
 * - Admin: full access (manages every student).
 * - Teacher: any student of their center (see studentScopeFor).
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
    // Same rule as studentScopeFor, read from the one student row.
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: { teacherId: true, teacher: { select: { centerId: true } } },
    });
    if (student && (student.teacherId === user.id || (user.centerId != null && student.teacher?.centerId === user.centerId))) {
      return;
    }
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

/**
 * Bulk form of assertCanAccessStudent for endpoints that write many students
 * at once (Teacher/Admin only). One query instead of one per id, and
 * all-or-nothing: if ANY id is not accessible the whole request is forbidden,
 * so a mixed list can never partially succeed.
 * Parent/Guardian are denied here — no bulk endpoint is meant for them.
 */
export async function assertCanAccessStudents(user, studentIds) {
  const ids = [...new Set(studentIds)];

  if (user.role === "Admin") return;

  if (user.role === "Teacher") {
    const owned = await prisma.student.count({
      where: { id: { in: ids }, ...studentScopeFor(user) },
    });
    if (owned === ids.length) return;
  }

  // Default deny
  throw new AppError("Forbidden", 403);
}

/**
 * Where a Teacher stands with a Parent/Guardian account, by its student links:
 * `own` links to students of the Teacher's center (see studentScopeFor),
 * `other` links to anyone else's (another center's, or a student with no
 * Teacher yet).
 *
 * - Seeing and editing an account is decided by its center, not by links.
 * - May delete: other === 0. A parent who also has a child at another
 *   center keeps that access; only an Admin can remove the account.
 */
export async function teacherAccountScope(user, accountId) {
  const scope = studentScopeFor(user) ?? { id: -1 };
  const [own, other] = await Promise.all([
    prisma.parentChild.count({ where: { parentId: accountId, student: scope } }),
    prisma.parentChild.count({ where: { parentId: accountId, NOT: { student: scope } } }),
  ]);
  return { own, other, canDelete: other === 0 };
}
