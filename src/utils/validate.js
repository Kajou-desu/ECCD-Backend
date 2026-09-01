import { AppError } from "../middleware/errorHandler.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
export const ATTENDANCE_STATUSES = ["present", "absent", "excused"];

export function parseId(raw, label = "id") {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(`Invalid ${label}`, 400);
  }
  return id;
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
