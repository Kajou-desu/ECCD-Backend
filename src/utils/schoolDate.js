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

// Minutes since local midnight, in the school's timezone, for the given
// instant. Used to decide whether an arrival is "late" against a wall-clock
// cutoff (e.g. 8:00 AM) without hardcoding an offset from UTC — the server
// itself runs in UTC, so "8 AM" only means something once converted through
// the school's actual timezone (and its DST rules, if any).
export function schoolMinutesOfDay(now = new Date(), timeZone = env.schoolTimezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  return hour * 60 + minute;
}
