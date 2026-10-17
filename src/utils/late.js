import { schoolMinutesOfDay } from "./schoolDate.js";

// A student is "late" if they arrive after their session's start-of-day
// cutoff, in the school's own timezone (not the server's/UTC's) — see
// schoolMinutesOfDay. Morning session: after 8:00 AM. Afternoon session:
// after 1:00 PM (13:00). Keyed by the Session enum values in validate.js.
export const LATE_CUTOFF_MINUTES = { morning: 8 * 60, afternoon: 13 * 60 };

// Falls back to the "morning" cutoff for a student row with no session,
// matching the Session enum's own default.
export function lateCutoffFor(session) {
  return LATE_CUTOFF_MINUTES[session] ?? LATE_CUTOFF_MINUTES.morning;
}

// Only a "present" record with a real arrival time can be late: a manually
// marked present with no arrivedAt (bulk entry, a back-dated day) has no
// arrival time to judge, so it is never counted as late.
export function isLateArrival(status, arrivedAt, session) {
  return status === "present" && Boolean(arrivedAt) && schoolMinutesOfDay(arrivedAt) > lateCutoffFor(session);
}
