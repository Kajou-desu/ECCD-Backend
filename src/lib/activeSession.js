import { prisma } from "./prisma.js";

// The single active attendance session, or null. The partial unique index on
// attendance_sessions guarantees there is at most one.
export function findActiveSession(select = { id: true, date: true }) {
  return prisma.attendanceSession.findFirst({ where: { status: "active" }, select });
}
