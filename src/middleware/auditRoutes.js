import { prisma } from "../lib/prisma.js";
import { audit } from "./audit.js";

// The audit middleware for each logged route, in one place so the routes files
// only need `auditX` in front of the handler. Every sentence is built from names,
// emails, titles, statuses and counts only — never passwords, tokens or OTP
// codes — and describe() returns nothing when the data it needs is missing
// (the entry is then skipped rather than logged half-empty).

const idOf = (value) => {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
};
const quote = (value) => (value ? `"${value}"` : "");
const studentName = (id) =>
  id === null ? null : prisma.student.findUnique({ where: { id }, select: { name: true } }).catch(() => null);

// Names of the request-body fields that were sent, minus anything secret.
const SECRET_FIELDS = new Set(["password", "otpCode", "token", "passwordHash"]);
const sentFields = (body) =>
  Object.keys(body ?? {}).filter((k) => !SECRET_FIELDS.has(k) && body[k] !== undefined);

// ---- auth ----
export const auditLogin = audit("auth.login", {
  target: "user",
  actor: "response",
  describe: (_req, body) => (body?.user ? "Signed in" : null),
});

// ---- accounts ----
export const auditAccountCreate = audit("account.create", {
  target: "user",
  describe: (_req, body) => body?.email && `Created ${body.role} account ${body.email}`,
});
export const auditAccountUpdate = audit("account.update", {
  target: "user",
  describe: (req, body) => {
    if (!body?.email) return null;
    const fields = sentFields(req.body).filter((k) => k !== "userId");
    const pw = req.body?.password ? " (password reset)" : "";
    return `Updated account ${body.email}${fields.length ? `: ${fields.join(", ")}` : ""}${pw}`;
  },
});
export const auditAccountDelete = audit("account.delete", {
  target: "user",
  snapshot: (req) =>
    prisma.user.findUnique({ where: { id: idOf(req.params.id) ?? -1 }, select: { email: true, role: true } }),
  describe: (_req, _body, before) => before && `Deleted ${before.role} account ${before.email}`,
});
export const auditOwnPasswordChange = audit("account.password", {
  target: "user",
  describe: () => "Changed own password",
});
export const auditOwnAccountDelete = audit("account.delete_self", {
  target: "user",
  actor: "detached",
  describe: (req) => `Deleted own account ${req.user.email}`,
});

// ---- students ----
export const auditStudentCreate = audit("student.create", {
  target: "student",
  describe: (_req, body) => body?.name && `Added student ${body.name}`,
});
export const auditStudentUpdate = audit("student.update", {
  target: "student",
  describe: (req, body) => {
    if (!body?.name) return null;
    const fields = sentFields(req.body);
    return `Updated student ${body.name}${fields.length ? `: ${fields.join(", ")}` : ""}`;
  },
});
export const auditStudentDelete = audit("student.delete", {
  target: "student",
  snapshot: (req) => studentName(idOf(req.params.id)),
  describe: (_req, _body, before) => before && `Deleted student ${before.name}`,
});
export const auditStudentImport = audit("student.import", {
  target: "student",
  describe: (_req, body) =>
    body && Number.isInteger(body.imported) && `Imported ${body.imported} student(s), ${body.failed?.length ?? 0} row(s) failed`,
});

// ---- attendance ----
export const auditAttendanceUpdate = audit("attendance.update", {
  target: "student",
  snapshot: (req) => studentName(idOf(req.params.studentId)),
  describe: (req, body, before) =>
    body && before && `Marked ${before.name} ${body.status ?? req.body?.status} on ${req.body?.date}`,
});
export const auditAttendanceBulk = audit("attendance.record", {
  describe: (_req, body) => Array.isArray(body) && `Recorded attendance for ${body.length} student(s)`,
});
export const auditAttendanceImport = audit("attendance.import", {
  describe: (_req, body) => {
    if (!body || body.dryRun !== false) return null; // a preview changes nothing
    return `Imported attendance: ${body.created} added, ${body.updated} updated, ${body.unchanged} unchanged, ${body.failed?.length ?? 0} row(s) failed`;
  },
});
export const auditAttendancePickup = audit("attendance.pickup", {
  target: "student",
  snapshot: (req) => studentName(idOf(req.params.studentId)),
  describe: (_req, _body, before) => before && `Recorded pickup of ${before.name}`,
});

// ---- centers, events, materials ----
export const auditCenterCreate = audit("center.create", {
  target: "center",
  describe: (_req, body) => body?.name && `Created center ${quote(body.name)}`,
});
export const auditCenterRename = audit("center.rename", {
  target: "center",
  snapshot: (req) => prisma.center.findUnique({ where: { id: idOf(req.params.id) ?? -1 }, select: { name: true } }),
  describe: (_req, body, before) =>
    body?.name && `Renamed center ${quote(before?.name ?? "?")} to ${quote(body.name)}`,
});

export const auditEventCreate = audit("event.create", {
  target: "event",
  describe: (_req, body) => body?.title && `Created event ${quote(body.title)}`,
});
export const auditEventUpdate = audit("event.update", {
  target: "event",
  describe: (_req, body) => body?.title && `Updated event ${quote(body.title)}`,
});
export const auditEventDelete = audit("event.delete", {
  target: "event",
  snapshot: (req) => prisma.event.findUnique({ where: { id: idOf(req.params.id) ?? -1 }, select: { title: true } }),
  describe: (_req, _body, before) => before && `Deleted event ${quote(before.title)}`,
});

export const auditMaterialCreate = audit("material.create", {
  target: "material",
  describe: (_req, body) => body?.title && `Added material ${quote(body.title)}`,
});
export const auditMaterialUpdate = audit("material.update", {
  target: "material",
  describe: (_req, body) => body?.title && `Updated material ${quote(body.title)}`,
});
export const auditMaterialDelete = audit("material.delete", {
  target: "material",
  snapshot: (req) => prisma.material.findUnique({ where: { id: idOf(req.params.id) ?? -1 }, select: { title: true } }),
  describe: (_req, _body, before) => before && `Deleted material ${quote(before.title)}`,
});
