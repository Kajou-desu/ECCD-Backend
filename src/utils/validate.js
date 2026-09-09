import { AppError } from "../middleware/errorHandler.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const PHONE_RE = /^[0-9+\-\s()]{7,20}$/;
export const ATTENDANCE_STATUSES = ["present", "absent", "excused"];
export const SESSIONS = ["morning", "afternoon"];
export const STUDENT_STATUSES = ["active", "inactive"];

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
  return value;
}

export function requireMonthString(value) {
  if (typeof value !== "string" || !MONTH_RE.test(value)) {
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

export function requireBirthday(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new AppError("Invalid birthday, expected YYYY-MM-DD", 400);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("Invalid birthday", 400);
  }
  return parsed;
}
