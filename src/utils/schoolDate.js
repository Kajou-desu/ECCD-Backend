import { env } from "../config/env.js";

// "YYYY-MM-DD" for the given instant in the school's timezone (default
// SCHOOL_TIMEZONE). The en-CA locale formats as ISO year-month-day. Uses only
// Intl, so no date library is needed and DST rules come from the platform.
export function schoolDateString(now = new Date(), timeZone = env.schoolTimezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// The same day as a UTC-midnight Date, matching how attendance.controller.js
// stores @db.Date values (toDate()).
export function schoolDateAsUtcMidnight(now = new Date(), timeZone = env.schoolTimezone) {
  return new Date(`${schoolDateString(now, timeZone)}T00:00:00.000Z`);
}
