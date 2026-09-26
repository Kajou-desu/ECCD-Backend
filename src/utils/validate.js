import { AppError } from "../middleware/errorHandler.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const PHONE_RE = /^[0-9+\-\s()]{7,20}$/;

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

export function parseId(raw, label = "id") {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
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

  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function requireEmail(email) {
  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    throw new AppError("Invalid email", 400);
  }
  return email.toLowerCase().trim();
}

export function requireDateString(value, label = "date") {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new AppError(`Invalid ${label}, expected YYYY-MM-DD`, 400);
  }
  const [year, month, day] = value.split("-").map(Number);
  if (!isRealCalendarDate(year, month, day)) {
    throw new AppError(`Invalid ${label}, expected YYYY-MM-DD`, 400);
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
  if (typeof value !== "string" || !EMAIL_RE.test(value)) {
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
  // bcrypt ignores everything past 72 bytes; reject rather than silently truncate.
  if (value.length > 72) {
    throw new AppError(`${label} must be at most 72 characters`, 400);
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
  return new Date(`${value}T00:00:00.000Z`);
}

export function requireGender(value) {
  if (typeof value !== "string" || !GENDERS.includes(value)) {
    throw new AppError("Invalid gender", 400);
  }
  return value;
}
