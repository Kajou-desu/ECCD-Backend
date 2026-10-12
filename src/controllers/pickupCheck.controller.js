import { parseId } from "../utils/validate.js";
import { answerPickupCheck } from "../services/pickupWatch.service.js";

// POST /attendance/session/pickup-checks/:id/answer  { stillHere: boolean }
// Teacher/Admin only (route level); the service additionally requires the user
// to be allowed to act on that student (their own, or any for an Admin).
export async function answerCheck(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    const { outcome } = await answerPickupCheck(req.user, id, req.body.stillHere);
    if (outcome === "not_found") return res.status(404).json({ message: "Not found" });
    if (outcome === "expired") return res.status(409).json({ message: "This check has already ended" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
