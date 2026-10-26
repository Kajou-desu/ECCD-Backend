import { AppError } from "../middleware/errorHandler.js";
import { parseId } from "./validate.js";

export const NO_CENTER_MESSAGE =
  "Your account is not assigned to a center yet. Ask an administrator to assign you to one.";

const CONTENT_READERS = new Set(["Teacher", "Parent", "Guardian"]);

/**
 * Which materials and event-photo albums a user may see, as a Prisma `where` for
 * Material or Album (both carry centerId). Decided by the VERIFIED user, never by
 * anything the client sends.
 * - Admin: every center's (they manage all of them), including rows with no center.
 * - Teacher / Parent / Guardian: their own center's and nothing else. A center's
 *   content is shared by its staff and families, not by the whole system.
 * - A user with no center yet, or any other role: null (deny). Callers must refuse
 *   (or return nothing) on null, never default to all.
 */
export function contentScopeFor(user) {
  if (user?.role === "Admin") return {};
  if (CONTENT_READERS.has(user?.role) && user.centerId != null) {
    return { centerId: user.centerId };
  }
  return null;
}

// Whether a Material/Album row that is already loaded falls inside a scope from
// contentScopeFor (a null scope contains nothing).
export function inContentScope(scope, row) {
  if (!scope || !row) return false;
  return scope.centerId === undefined || row.centerId === scope.centerId;
}

/**
 * The same scope for staff-only work on content (changing it, deleting it, seeing
 * who handed in what), which only Teachers and Admins may do. Throws instead of
 * returning null (default deny).
 */
export function staffContentScopeFor(user) {
  if (user?.role !== "Admin" && user?.role !== "Teacher") throw new AppError("Forbidden", 403);
  const scope = contentScopeFor(user);
  if (!scope) throw new AppError(NO_CENTER_MESSAGE, 403);
  return scope;
}

/**
 * The center a NEW material or album is created in.
 * - Teacher: their own center. Any centerId in the body is ignored.
 * - Admin: has no center of their own, so the request must name it. That is a
 *   choice among centers they already manage, not a claim about who they are
 *   (a center that doesn't exist fails the foreign key; see isMissingCenter).
 * - Anyone else: forbidden.
 */
export function centerForNewContent(req) {
  const { user } = req;
  if (user?.role === "Teacher") {
    if (user.centerId == null) throw new AppError(NO_CENTER_MESSAGE, 403);
    return user.centerId;
  }
  if (user?.role === "Admin") return parseId(req.body?.centerId, "centerId");
  throw new AppError("Forbidden", 403);
}

// Prisma's "foreign key constraint failed": an Admin named a center that doesn't exist.
export const isMissingCenter = (err) => err?.code === "P2003";
