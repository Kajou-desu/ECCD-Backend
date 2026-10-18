import { AppError } from "../middleware/errorHandler.js";
import { parseId } from "./validate.js";

// Which center's live attendance session a request acts on. Decided by the
// VERIFIED user, not by what the client says about itself:
//
// - Teacher: their own center, from req.user (null = not assigned to one yet).
//   Anything the client sends about the center is ignored.
// - Admin: has no center of their own and may manage every one, so the request
//   must name it, in the body (`from: "body"`, the default, for POST) or the
//   query (`from: "query"`, for GET). That is a choice among centers they may
//   already act on, not a claim about who they are. Returns undefined when
//   `required` is false and none was named ("no session chosen yet").
// - Anyone else: forbidden.
export function sessionCenterFor(req, { required = true, from = "body" } = {}) {
  const { user } = req;
  if (user?.role === "Teacher") return user.centerId ?? null;
  if (user?.role === "Admin") {
    const raw = req[from]?.centerId;
    if (raw === undefined && !required) return undefined;
    return parseId(raw, "centerId");
  }
  throw new AppError("Forbidden", 403);
}
