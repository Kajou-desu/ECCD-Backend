import { AppError } from "../middleware/errorHandler.js";
import { schoolDateString } from "./schoolDate.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const MIN_BIRTH_YEAR = 1900;
const MAX_EMAIL_LENGTH = 254; // RFC 5321
const PHONE_RE = /^[0-9+\-\s()]{7,20}$/;

// Philippine mobile number, with or without country code/trunk prefix:
// 9XXXXXXXXX (bare 10 digits), 09XXXXXXXXX, 639XXXXXXXXX or +639XXXXXXXXX
// (separators stripped first). Shared with lib/sms.js so what we accept on
// save is exactly what the SMS providers can deliver to.
export const PH_MOBILE_RE = /^(?:\+?63|0)?9\d{9}$/;

export function normalizePhone(phone) {
  return String(phone ?? "").replace(/[\s\-()]/g, "");
}

// DATE_RE/MONTH_RE only check the string's SHAPE (4 digits - 2 digits [-
// 2 digits]), not that it names a real calendar date. Date.UTC silently
// rolls an out-of-range value over into a different, valid date instead of
// failing (e.g. 2026-02-30 becomes 2026-03-02; a 2026-13-01 month becomes
// January 2027) — so a typo would previously be saved as a different, wrong
// date rather than rejected. This rebuilds the string from the parsed parts
// and requires an exact match, which only round-trips for a real date.
function isRealCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
export const ATTENDANCE_STATUSES = ["present", "absent", "excused"];
export const SESSIONS = ["morning", "afternoon"];
export const STUDENT_STATUSES = ["active", "inactive"];
export const GENDERS = ["male", "female", "other", "prefer_not_to_say"];

// Prisma Int columns are 32-bit signed; anything larger fails inside the
// database driver (a 500) instead of being rejected here as a 400.
const MAX_INT32 = 2147483647;

// Accepts a positive integer, either as a number or as a plain decimal digit
// string. Number() alone would also accept "1e3", "0x10" and " 5 ".
export function parseId(raw, label = "id") {
  const isDigitString = typeof raw === "string" && /^\d{1,10}$/.test(raw);
  const id = typeof raw === "number" ? raw : isDigitString ? Number(raw) : NaN;
  if (!Number.isInteger(id) || id <= 0 || id > MAX_INT32) {
    throw new AppError(`Invalid ${label}`, 400);
  }
  return id;
}

// Opt-in pagination for list endpoints. Returns { page, pageSize, skip,
// take } when BOTH ?page and ?pageSize are provided, or null when neither
// is — callers use that null to fall back to their existing unpaginated
// query, so responses are byte-for-byte unchanged for any client that
// doesn't ask for a page (i.e. every current frontend caller).
export function parsePagination(query, { maxPageSize = 200 } = {}) {
  if (query.page === undefined && query.pageSize === undefined) return null;

  const page = parseId(query.page, "page");
  const pageSize = parseId(query.pageSize, "pageSize");
  if (pageSize > maxPageSize) {
    throw new AppError(`pageSize must be ${maxPageSize} or less`, 400);
  }

  const skip = (page - 1) * pageSize;
  if (skip > MAX_INT32) {
    throw new AppError("Invalid page", 400);
  }

  return { page, pageSize, skip, take: pageSize };
}

export function requireEmail(email) {
  if (typeof email !== "string" || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    throw new AppError("Invalid email", 400);
  }
  return email.toLowerCase().trim();
}

// Sanity window for school/calendar dates (attendance, events, daily themes).
// Not a business rule — it only stops typos such as year 0202 or 20260 from
// being stored; future-date rules stay with the callers that need them.
const MIN_CALENDAR_YEAR = 2000;
const MAX_CALENDAR_YEAR = 2100;

export function requireDateString(value, label = "date") {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new AppError(`Invalid ${label}, expected YYYY-MM-DD`, 400);
  }
  const [year, month, day] = value.split("-").map(Number);
  if (!isRealCalendarDate(year, month, day)) {
    throw new AppError(`Invalid ${label}, expected YYYY-MM-DD`, 400);
  }
  if (year < MIN_CALENDAR_YEAR || year > MAX_CALENDAR_YEAR) {
    throw new AppError(`Invalid ${label}, year must be between ${MIN_CALENDAR_YEAR} and ${MAX_CALENDAR_YEAR}`, 400);
  }
  return value;
}

export function requireMonthString(value) {
  if (typeof value !== "string" || !MONTH_RE.test(value)) {
    throw new AppError("Invalid month, expected YYYY-MM", 400);
  }
  const [, month] = value.split("-").map(Number);
  if (month < 1 || month > 12) {
    throw new AppError("Invalid month, expected YYYY-MM", 400);
  }
  return value;
}

export function requireAttendanceStatus(value) {
  if (!ATTENDANCE_STATUSES.includes(value)) {
    throw new AppError(`Invalid status, expected one of: ${ATTENDANCE_STATUSES.join(", ")}`, 400);
  }
  return value;
}

export function requireNonEmptyString(value, label, maxLength = 255) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new AppError(`Invalid ${label}`, 400);
  }
  return value.trim();
}

// For fields that are allowed to be blank/absent (returns null, not "").
export function optionalString(value, maxLength = 1000) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new AppError("Invalid text field", 400);
  }
  return value.trim();
}

export function optionalEmail(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(value)) {
    throw new AppError("Invalid email", 400);
  }
  return value.toLowerCase().trim();
}

export function requirePhone(value, label = "phone") {
  if (typeof value !== "string" || !PHONE_RE.test(value.trim())) {
    throw new AppError(`Invalid ${label}`, 400);
  }
  return value.trim();
}

export function optionalPhone(value, label = "phone") {
  if (value === undefined || value === null || value === "") return null;
  return requirePhone(value, label);
}

// For accounts that receive SMS (Parent/Guardian): a number Semaphore can't
// deliver to would silently never get an alert, so reject it at save time.
export function requirePhMobile(value, label = "phone") {
  if (typeof value !== "string" || value.length > 20 || !PH_MOBILE_RE.test(normalizePhone(value))) {
    throw new AppError(`Invalid ${label}: use a Philippine mobile number, e.g. 09171234567`, 400);
  }
  return value.trim();
}

export function optionalPhMobile(value, label = "phone") {
  if (value === undefined || value === null || value === "") return null;
  return requirePhMobile(value, label);
}

export function requireSession(value) {
  const v = value ?? "morning";
  if (!SESSIONS.includes(v)) {
    throw new AppError(`Invalid session, expected one of: ${SESSIONS.join(", ")}`, 400);
  }
  return v;
}

export function requireStudentStatus(value) {
  const v = value ?? "active";
  if (!STUDENT_STATUSES.includes(v)) {
    throw new AppError(`Invalid status, expected one of: ${STUDENT_STATUSES.join(", ")}`, 400);
  }
  return v;
}

export function requirePassword(value, label = "password") {
  if (typeof value !== "string" || value.length < 10) {
    throw new AppError(`${label} must be at least 10 characters`, 400);
  }
  // bcrypt ignores everything past 72 BYTES, and a non-ASCII character takes
  // 2-4 bytes in UTF-8, so a character count would let a 40-character
  // password through that is then silently truncated. Reject rather than
  // truncate.
  if (Buffer.byteLength(value, "utf8") > 72) {
    throw new AppError(`${label} must be at most 72 characters (non-English characters count as more than one)`, 400);
  }
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    throw new AppError(`${label} must contain at least one letter and one number`, 400);
  }
  return value;
}

export function requireBirthday(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new AppError("Invalid birthday, expected YYYY-MM-DD", 400);
  }
  const [year, month, day] = value.split("-").map(Number);
  if (!isRealCalendarDate(year, month, day)) {
    throw new AppError("Invalid birthday, expected YYYY-MM-DD", 400);
  }
  // A birthday can't be in the future (compared against the school-local
  // today) or implausibly old for a child record.
  if (year < MIN_BIRTH_YEAR || value > schoolDateString()) {
    throw new AppError("Invalid birthday, date is out of range", 400);
  }
  return new Date(`${value}T00:00:00.000Z`);
}

export function requireGender(value) {
  if (typeof value !== "string" || !GENDERS.includes(value)) {
    throw new AppError("Invalid gender", 400);
  }
  return value;
}

// 0-100 inclusive integer, as sent from a progress slider/input.
export function requireProgress(value) {
  // Number("") / Number(null) / Number([]) are all 0, which would silently
  // record "0% progress" for a missing or malformed value. Only a number or
  // a plain digit string is accepted.
  const progress =
    typeof value === "number" ? value : typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    throw new AppError("Invalid progress, expected an integer from 0 to 100", 400);
  }
  return progress;
}

// Array of short strings (DailyTheme.objectives, teacher-entered lesson
// checklist items). Empty array is valid — "no objectives set" is a normal
// state, not an error.
export function requireStringArray(value, label, { maxItems = 20, maxLength = 300 } = {}) {
  if (!Array.isArray(value)) {
    throw new AppError(`Invalid ${label}, expected an array of strings`, 400);
  }
  if (value.length > maxItems) {
    throw new AppError(`${label} must have at most ${maxItems} items`, 400);
  }
  return value.map((item, idx) => requireNonEmptyString(item, `${label}[${idx}]`, maxLength));
}
