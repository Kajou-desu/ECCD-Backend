import { schoolMinutesOfDay } from "./schoolDate.js";
import { DEFAULT_SCHOOL_TIMES } from "./schoolTimes.js";

// A student is "late" if they arrive after their session's start time, in the
// school's own timezone (not the server's/UTC's) — see schoolMinutesOfDay. The
// start times are the center's own school times (see utils/schoolTimes.js and
// lib/schoolTimes.js); without any they are the defaults, 8:00 AM for the
// morning session and 1:00 PM for the afternoon one.
//
// `times` is a row/object with morningStartMin and afternoonStartMin. Falls back
// to the "morning" start for a student row with no session, matching the
// Session enum's own default.
export function lateCutoffFor(session, times = DEFAULT_SCHOOL_TIMES) {
  return session === "afternoon" ? times.afternoonStartMin : times.morningStartMin;
}

// Only a "present" record with a real arrival time can be late: a manually
// marked present with no arrivedAt (bulk entry, a back-dated day) has no
// arrival time to judge, so it is never counted as late.
export function isLateArrival(status, arrivedAt, session, times) {
  return status === "present" && Boolean(arrivedAt) && schoolMinutesOfDay(arrivedAt) > lateCutoffFor(session, times);
}

// What to show for a stored record: the decision made when it was recorded
// (`record.late`, see lib/lateFlag.js). Only a record from before that column
// existed (late is null) is still judged live, with the student's CURRENT
// session and center times, until the backfill script has fixed it.
export function lateOf(record, session, times) {
  return record.late ?? isLateArrival(record.status, record.arrivedAt, session, times);
}
