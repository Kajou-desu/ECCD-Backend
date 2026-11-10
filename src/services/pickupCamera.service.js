import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { centerKey } from "../lib/activeSession.js";
import { mergeSignal, isSignalPresent } from "./attendanceVerification.service.js";
import { autoMarkPickedUp, findPickupOverride, pickupWindowCovers } from "./pickupWatch.service.js";

// The two-camera side of automatic pickup.
//
//   EXIT camera  — a face it recognises, while a pickup window covers that
//                  student, VERIFY_MIN_HITS times in a row => picked up.
//   ENTRY camera — a face of a student who was picked up AUTOMATICALLY => the
//                  teachers are told in-app (once per pickup). The pickup is
//                  never undone by the system; a teacher decides.
//
// Both are called by the frame controller (controllers/attendanceFrame.controller.js),
// which has already checked the caller's scope, the match confidence and that the
// student's center has an active session.

const signalKey = (sessionId, studentId) => ({ sessionId_studentId_kind: { sessionId, studentId, kind: "exit" } });

// Folds one exit-camera reading into the student's "exit" signal row and returns it.
async function recordExitSignal({ sessionId, studentId, distance, now }) {
  const prev = await prisma.attendanceSignal.findUnique({
    where: signalKey(sessionId, studentId),
    select: { score: true, hits: true, lastSeenAt: true },
  });
  const next = mergeSignal(prev, distance, now);
  await prisma.attendanceSignal.upsert({
    where: signalKey(sessionId, studentId),
    create: { sessionId, studentId, kind: "exit", ...next },
    update: next,
  });
  return next;
}

// One exit-camera sighting of a confidently matched student. `student` is
// { id, session: "morning" | "afternoon", centerId }. `overrides` is a Map the
// caller shares across the faces of one frame, so a center's pickup override is
// read once per frame. Returns { pickedUp: boolean }.
//
// A sighting outside a pickup window is dropped without a write: a child walking
// out at 9:30 stays a manual pickup, and the idle camera costs no database load.
export async function handleExitSighting({ session, student, distance, now = new Date(), overrides = new Map() }) {
  const key = centerKey(student.centerId);
  if (!overrides.has(key)) overrides.set(key, await findPickupOverride(student.centerId, now));
  if (!pickupWindowCovers(overrides.get(key), student.session, now)) return { pickedUp: false };

  const signal = await recordExitSignal({ sessionId: session.id, studentId: student.id, distance, now });
  // Same rule as arrival: seen enough times in a row, and a close enough match.
  if (!isSignalPresent("exit", signal, now)) return { pickedUp: false };

  // Only a present student, who has arrived and is not yet picked up, is marked;
  // the guarded write inside autoMarkPickedUp is race-safe and notifies parents once.
  const pickedUp = await autoMarkPickedUp(student.id, session.date, now, "exit_camera");
  return { pickedUp };
}

// Entry-camera sightings that are already stable (enough hits in a row).
// `sightings` is [{ studentId, date }]. One query finds those who were picked up
// automatically and not yet alerted about, so a frame with ordinary arrivals
// costs a single read; only those few go on to claim and send the alert.
export async function alertStudentsSeenAfterAutoPickup(sightings, now = new Date()) {
  if (sightings.length === 0) return;
  const dates = [...new Set(sightings.map((s) => s.date.getTime()))].map((t) => new Date(t));
  const awaiting = await prisma.attendance.findMany({
    where: {
      studentId: { in: sightings.map((s) => s.studentId) },
      date: { in: dates },
      pickedUpAuto: true,
      pickedUpAt: { not: null },
      pickupReturnAlertedAt: null,
    },
    select: { studentId: true, date: true },
  });
  for (const a of awaiting) await alertIfSeenAfterAutoPickup(a.studentId, a.date, now);
}

// Claims the alert with a guarded write so only one frame (or one API instance)
// sends it, then tells the student's teachers and their colleagues at the same
// center. Returns whether an alert was sent.
export async function alertIfSeenAfterAutoPickup(studentId, today, now = new Date()) {
  const claimed = await prisma.attendance.updateMany({
    where: { studentId, date: today, pickedUpAuto: true, pickedUpAt: { not: null }, pickupReturnAlertedAt: null },
    data: { pickupReturnAlertedAt: now },
  });
  if (claimed.count === 0) return false;

  try {
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: { name: true, teacherId: true, teacher: { select: { centerId: true } } },
    });
    if (!student) return false;

    const teacherIds = new Set();
    if (student.teacherId != null) teacherIds.add(student.teacherId);
    const centerId = student.teacher?.centerId;
    if (centerId != null) {
      const colleagues = await prisma.user.findMany({
        where: { role: "Teacher", centerId, isActive: true },
        select: { id: true },
      });
      colleagues.forEach((t) => teacherIds.add(t.id));
    }
    if (teacherIds.size === 0) return false;

    await prisma.notification.createMany({
      data: [...teacherIds].map((userId) => ({
        userId,
        title: "Picked-up student seen again",
        message: `${student.name} was marked picked up automatically but the entry camera has seen them again. Open Live attendance and check.`,
      })),
    });
    logger.info({ studentId, teachers: teacherIds.size }, "Seen-again alert sent after an automatic pickup");
    return true;
  } catch (err) {
    // Never fail the frame over a notification; the claim above already stops repeats.
    logger.error({ err, studentId }, "Seen-again alert failed");
    return false;
  }
}
