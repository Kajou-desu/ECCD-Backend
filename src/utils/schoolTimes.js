import { AppError } from "../middleware/errorHandler.js";

// A center's school hours, in minutes since midnight in the school's timezone
// (the same unit schoolMinutesOfDay returns). The morning start is also the late
// cutoff for morning students, and the afternoon start for afternoon students
// (see late.js). These apply to any center that has not saved times of its own,
// and match the cutoffs the app used before they were configurable (8:00 AM and
// 1:00 PM); the ends sit where automatic pickup starts by default (PICKUP_*_START).
export const DEFAULT_SCHOOL_TIMES = Object.freeze({
  morningStartMin: 8 * 60,
  morningEndMin: 10 * 60 + 30,
  afternoonStartMin: 13 * 60,
  afternoonEndMin: 14 * 60 + 30,
});

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// "08:30" (24-hour, as <input type="time"> sends it) -> 510.
export function parseClock(value, label) {
  const match = typeof value === "string" ? CLOCK_RE.exec(value) : null;
  if (!match) throw new AppError(`${label} must be a 24-hour time like "08:00"`, 400);
  return Number(match[1]) * 60 + Number(match[2]);
}

// 510 -> "08:30".
export function formatClock(minutes) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

// The request body ({ morningStart, morningEnd, afternoonStart, afternoonEnd },
// all "HH:MM") as the stored minutes, or a 400. Only these four fields are read,
// so nothing else in the body can reach the database.
export function requireSchoolTimes(body) {
  const times = {
    morningStartMin: parseClock(body?.morningStart, "morningStart"),
    morningEndMin: parseClock(body?.morningEnd, "morningEnd"),
    afternoonStartMin: parseClock(body?.afternoonStart, "afternoonStart"),
    afternoonEndMin: parseClock(body?.afternoonEnd, "afternoonEnd"),
  };
  if (times.morningStartMin >= times.morningEndMin) {
    throw new AppError("The morning session must end after it starts", 400);
  }
  if (times.afternoonStartMin >= times.afternoonEndMin) {
    throw new AppError("The afternoon session must end after it starts", 400);
  }
  if (times.morningEndMin > times.afternoonStartMin) {
    throw new AppError("The afternoon session cannot start before the morning session ends", 400);
  }
  return times;
}

// Stored minutes -> what the API sends and the settings form shows.
export function toSchoolTimesResponse(times) {
  return {
    morningStart: formatClock(times.morningStartMin),
    morningEnd: formatClock(times.morningEndMin),
    afternoonStart: formatClock(times.afternoonStartMin),
    afternoonEnd: formatClock(times.afternoonEndMin),
  };
}
