import { prisma } from "./prisma.js";

// Live attendance sessions are per center. A center's key is its id, or null for
// the Teachers not yet assigned to a center, who share one session of their own.
export const centerKey = (centerId) => centerId ?? null;

const DEFAULT_SELECT = { id: true, date: true, centerId: true };

// One center's active session, or null. The partial unique index on
// attendance_sessions guarantees there is at most one per center.
export function findActiveSession(centerId, select = DEFAULT_SELECT) {
  return prisma.attendanceSession.findFirst({
    where: { status: "active", centerId: centerKey(centerId) },
    select,
  });
}

// Every active session (at most one per center), for work that spans centers
// such as the gateway and the pickup watch. `select` must include centerId.
export function findActiveSessions(select = DEFAULT_SELECT) {
  return prisma.attendanceSession.findMany({ where: { status: "active" }, select });
}

// The active sessions this user may feed with camera frames: their own center's
// (a Teacher) or any center's (an Admin). Any other role gets none (default deny).
export async function findActiveSessionsFor(user, select = DEFAULT_SELECT) {
  if (user?.role === "Admin") return findActiveSessions(select);
  if (user?.role === "Teacher") {
    return prisma.attendanceSession.findMany({
      where: { status: "active", centerId: centerKey(user.centerId) },
      select,
    });
  }
  return [];
}

// centerKey -> session
export function sessionsByCenter(sessions) {
  return new Map(sessions.map((s) => [centerKey(s.centerId), s]));
}
