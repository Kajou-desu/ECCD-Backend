import { AppError } from "../middleware/errorHandler.js";
import { studentScopeFor } from "./ownership.js";

// Which students a live-attendance request may see or recognise: an Admin
// everyone, a Teacher the students of their own center (teachers at one center
// share their data) — the same rule as the daily attendance roster, so a face
// seen on camera can never be marked present, or named, for a student the
// Teacher couldn't see in their own list. Anything else is denied rather than
// defaulting to all.
export function liveStudentScope(user) {
  const scope = studentScopeFor(user);
  if (!scope) throw new AppError("Forbidden", 403);
  return scope;
}
