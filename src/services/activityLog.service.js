import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

// The categories the Activity Logs page can filter by (the part of an action
// before the dot). Keep in sync with the frontend's label list.
export const ACTIVITY_CATEGORIES = ["auth", "account", "student", "attendance", "center", "event", "material", "export"];

export const MAX_SUMMARY_LENGTH = 300;

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

// Writes one log row. It NEVER throws and callers don't need to await it: a
// problem with the log must not turn a successful action into an error, so a
// failure is only written to the server log.
//   actor: { id, email, role }   (req.user, or the user just signed in)
export async function recordActivity({ actor, action, targetType = null, targetId = null, summary }) {
  try {
    if (!actor?.email || !action || !summary) return;
    await prisma.activityLog.create({
      data: {
        actorId: Number.isInteger(actor.id) ? actor.id : null,
        actorEmail: clean(actor.email, 254),
        actorRole: clean(actor.role, 30),
        action: clean(action, 60),
        targetType: targetType ? clean(targetType, 30) : null,
        targetId: Number.isInteger(targetId) ? targetId : null,
        summary: clean(summary, MAX_SUMMARY_LENGTH),
      },
    });
  } catch (err) {
    logger.error({ err, action }, "Could not write an activity log entry");
  }
}
