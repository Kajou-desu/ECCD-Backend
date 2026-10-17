import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { findActiveSession } from "../lib/activeSession.js";
import { isCameraAlive, isGatewayOnline } from "../lib/hardwareStatus.js";
import { schoolDateAsUtcMidnight, schoolMinutesOfDay } from "../utils/schoolDate.js";
import { evaluate } from "./attendanceVerification.service.js";
import { notifyPickup } from "./attendanceNotification.service.js";
import { assertCanAccessStudent, studentScopeFor } from "../utils/ownership.js";

// Automatic pickup.
//
// During a pickup window (morning students from PICKUP_MORNING_START, afternoon
// students from PICKUP_AFTERNOON_START, for PICKUP_WINDOW_HOURS) a present
// student whose face AND BLE tag have both gone unseen is checked on:
//
//   * after 1 minute unseen the teacher gets an in-app "still in the center?"
//     prompt that lasts 15 s. "Still here" restarts the clock, "Picked up" marks
//     the student picked up. Unanswered, it expires and a new one is made a
//     minute later;
//   * after PICKUP_ABSENT_MIN (5) minutes unseen with no "still here", the
//     student is marked picked up automatically. Parents get the same
//     notification as a manual pickup;
//   * an auto-marked student who is seen again (face + tag) inside the window is
//     put back. Outside the window the pickup stands.
//
// Silence is weak evidence, so nothing happens unless the ESP32 gateway AND the
// camera are demonstrably alive, and the clock restarts after any outage.
// The decisions are pure functions; runPickupWatch is the database wrapper.

export const PROMPT_EVERY_MS = 60_000;
export const PROMPT_TTL_MS = 15_000;
const SESSIONS = ["morning", "afternoon"];
// A "pickup window is over" reminder is only worth sending soon after the end.
const REMINDER_GRACE_MIN = 60;

const MINUTE_MS = 60_000;

// ---- pure helpers -----------------------------------------------------------

export function pickupWindow(session, cfg = env.pickup) {
  const startMin = session === "afternoon" ? cfg.afternoonStartMin : cfg.morningStartMin;
  return { startMin, endMin: startMin + cfg.windowMs / MINUTE_MS };
}

export function sessionsInWindow(nowMinutes, cfg = env.pickup) {
  return SESSIONS.filter((s) => {
    const { startMin, endMin } = pickupWindow(s, cfg);
    return nowMinutes >= startMin && nowMinutes < endMin;
  });
}

// The instant at a given school-local minute-of-day, relative to `now`. Time
// zones differ from UTC by whole minutes, so flooring `now` to the minute and
// offsetting by the minute difference is exact.
export function instantAtMinute(now, nowMinutes, minuteOfDay) {
  return new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS + (minuteOfDay - nowMinutes) * MINUTE_MS);
}

// For the monitor: is any pickup window open right now, and when does it close?
export function pickupWindowStatus(now = new Date(), cfg = env.pickup) {
  const nowMinutes = schoolMinutesOfDay(now);
  const open = sessionsInWindow(nowMinutes, cfg);
  if (open.length === 0) return { active: false, endsAt: null };
  const endMin = Math.max(...open.map((s) => pickupWindow(s, cfg).endMin));
  return { active: true, endsAt: instantAtMinute(now, nowMinutes, endMin) };
}

const latestOf = (dates) => dates.filter(Boolean).reduce((a, b) => (b > a ? b : a), new Date(0));

// When the current continuous "neither face nor tag seen" stretch began: the
// latest of the last sighting by either signal, the teacher's last "still here",
// the student's arrival, the start of the window, and the end of the last hardware outage.
export function absentSince({ lastFaceAt, lastBleAt, stillHereAt, arrivedAt, windowStart, unhealthyAt }) {
  return latestOf([lastFaceAt, lastBleAt, stillHereAt, arrivedAt, windowStart, unhealthyAt]);
}

// "wait" | "prompt" | "pick_up". `lastCheck` is the student's newest prompt today:
// { createdAt, expiresAt, answeredAt } | null.
export function decidePickupAction({ now, absentSince: since, lastCheck, cfg = env.pickup }) {
  const t = now.getTime();
  // A prompt is on the teacher's screen: let them answer (or let it expire).
  if (lastCheck && !lastCheck.answeredAt && lastCheck.expiresAt.getTime() > t) return "wait";
  if (t - since.getTime() >= cfg.absentMs) return "pick_up";
  // The next prompt is due a minute after the absence began or after the last
  // prompt (made during this absence) ended.
  const dueFrom = lastCheck && lastCheck.createdAt > since ? lastCheck.expiresAt.getTime() : since.getTime();
  return t - dueFrom >= PROMPT_EVERY_MS ? "prompt" : "wait";
}

// ---- shared writes ----------------------------------------------------------

// Marks today's record picked up unless it already is (or isn't "present").
// Race-safe: the guarded updateMany lets only one caller win, and only the
// winner notifies parents. `auto` is false when the teacher said so themselves:
// that is a manual decision and is never undone. Returns whether this call did it.
export async function autoMarkPickedUp(studentId, today, now = new Date(), { auto = true } = {}) {
  const { count } = await prisma.attendance.updateMany({
    where: { studentId, date: today, status: "present", arrivedAt: { not: null }, pickedUpAt: null },
    data: { pickedUpAt: now, pickedUpAuto: auto },
  });
  if (count === 0) return false;
  logger.info({ studentId, auto }, "Student marked picked up by the pickup watch");
  // Fire-and-forget, same as the manual path: a failed SMS must not undo this.
  Promise.resolve()
    .then(() => notifyPickup(studentId, now))
    .catch(() => {});
  return true;
}

// ---- the periodic job -------------------------------------------------------

// Start of the current "everything has been healthy" stretch; absence is never
// counted from before it. Starts at process start (a restart is an outage too).
let unhealthyAt = new Date();
export function resetPickupHealth(date = new Date()) {
  unhealthyAt = date;
}

const SESSION_SELECT = { id: true, date: true, autoStarted: true, startedAt: true, stopReminderSentAt: true };

// `windowStart` is when the current window opened. A pickup session that was
// already stopped since then (by a teacher, or because everyone was picked up)
// is not started again — Stop must mean stop — so null comes back.
async function ensureAutoSession(today, session, windowStart) {
  if (session && session.date.getTime() !== today.getTime()) {
    // Left over from a previous day: close it (guarded) like startSession does.
    await prisma.attendanceSession.updateMany({
      where: { id: session.id, status: "active" },
      data: { status: "closed", endedAt: new Date() },
    });
    session = null;
  }
  if (session) return session;
  const stopped = await prisma.attendanceSession.findFirst({
    where: { date: today, autoStarted: true, status: "closed", endedAt: { gte: windowStart } },
    select: { id: true },
  });
  if (stopped) return null;
  try {
    const created = await prisma.attendanceSession.create({
      data: { date: today, startedById: null, autoStarted: true },
      select: SESSION_SELECT,
    });
    logger.info({ sessionId: created.id }, "Attendance session auto-started for pickup tracking");
    return created;
  } catch (err) {
    // Lost a race with a teacher pressing Start (database allows one active session).
    if (err?.code === "P2002") return findActiveSession(SESSION_SELECT);
    throw err;
  }
}

// Once per session, when the window ends while the camera session is still
// running, tell the affected teachers (in-app only) to stop it.
async function sendStopReminder(session, today, now, nowMinutes) {
  if (!session || session.stopReminderSentAt) return;
  for (const type of SESSIONS) {
    const { endMin } = pickupWindow(type);
    if (nowMinutes < endMin || nowMinutes >= endMin + REMINDER_GRACE_MIN) continue;
    // A session started after this window closed has nothing to do with it.
    if (session.startedAt >= instantAtMinute(now, nowMinutes, endMin)) continue;

    const claimed = await prisma.attendanceSession.updateMany({
      where: { id: session.id, stopReminderSentAt: null },
      data: { stopReminderSentAt: now },
    });
    if (claimed.count === 0) return;

    const rows = await prisma.attendance.findMany({
      where: { date: today, status: "present", student: { session: type, teacherId: { not: null } } },
      select: { student: { select: { teacherId: true, teacher: { select: { centerId: true } } } } },
    });
    // The teachers of those students and their colleagues at the same center
    // (a center's teachers share its attendance and live monitor).
    const teacherSet = new Set(rows.map((r) => r.student.teacherId));
    const centerIds = [...new Set(rows.map((r) => r.student.teacher?.centerId).filter((c) => c != null))];
    if (centerIds.length > 0) {
      const colleagues = await prisma.user.findMany({
        where: { role: "Teacher", centerId: { in: centerIds }, isActive: true },
        select: { id: true },
      });
      colleagues.forEach((t) => teacherSet.add(t.id));
    }
    const teacherIds = [...teacherSet];
    if (teacherIds.length > 0) {
      await prisma.notification.createMany({
        data: teacherIds.map((userId) => ({
          userId,
          title: "Pickup tracking is still running",
          message:
            "The pickup window has ended. Open Live attendance, turn off the camera and press Stop Attendance if everyone has been picked up.",
        })),
      });
    }
    logger.info({ sessionId: session.id, teachers: teacherIds.length }, "Pickup stop reminder sent");
    return;
  }
}

export async function runPickupWatch(now = new Date()) {
  const nowMinutes = schoolMinutesOfDay(now);
  const today = schoolDateAsUtcMidnight(now);

  let session = await findActiveSession(SESSION_SELECT);
  await sendStopReminder(session, today, now, nowMinutes);

  const types = sessionsInWindow(nowMinutes);
  if (types.length === 0) return;

  // Present, not yet picked up (or auto-picked up, for the undo), with at
  // least one enabled tag: without a tag "both gone" can't be judged, so those
  // students stay manual.
  const records = await prisma.attendance.findMany({
    where: {
      date: today,
      status: "present",
      arrivedAt: { not: null },
      student: { status: "active", session: { in: types }, bleDevices: { some: { enabled: true } } },
    },
    select: {
      id: true,
      studentId: true,
      arrivedAt: true,
      pickedUpAt: true,
      pickedUpAuto: true,
      student: { select: { session: true } },
    },
  });
  const pending = records.filter((r) => !r.pickedUpAt);
  const autoPickedUp = records.filter((r) => r.pickedUpAt && r.pickedUpAuto);

  // No teacher has to press Start: the ESP32 only scans, and the camera only
  // sends frames, while a session is active.
  if (pending.length > 0) {
    const windowStart = instantAtMinute(now, nowMinutes, Math.min(...types.map((t) => pickupWindow(t).startMin)));
    session = await ensureAutoSession(today, session, windowStart);
  } else if (session?.autoStarted) {
    // Everyone is picked up: end the session this job started, which also
    // turns the teacher's camera off (the live page stops it with the session).
    await prisma.attendanceSession.updateMany({
      where: { id: session.id, status: "active" },
      data: { status: "closed", endedAt: now },
    });
    logger.info({ sessionId: session.id }, "Pickup tracking finished: session closed");
  }
  if (records.length === 0) return;

  if (!session || !(await isGatewayOnline(now)) || !isCameraAlive(now)) {
    unhealthyAt = now; // never count silence while the eyes were closed
    return;
  }

  const ids = records.map((r) => r.studentId);
  const [signals, checks] = await Promise.all([
    prisma.attendanceSignal.findMany({
      where: { studentId: { in: ids }, session: { date: today } },
      select: { studentId: true, kind: true, score: true, hits: true, lastSeenAt: true },
    }),
    prisma.pickupCheck.findMany({
      where: { studentId: { in: ids }, date: today },
      orderBy: { createdAt: "asc" },
      select: { studentId: true, createdAt: true, expiresAt: true, answeredAt: true, answer: true },
    }),
  ]);

  // Newest sighting per (student, kind) across today's sessions.
  const latest = new Map();
  for (const s of signals) {
    const key = `${s.studentId}:${s.kind}`;
    if (!latest.has(key) || s.lastSeenAt > latest.get(key).lastSeenAt) latest.set(key, s);
  }
  const lastCheck = new Map();
  const stillHere = new Map();
  for (const c of checks) {
    lastCheck.set(c.studentId, c);
    if (c.answer === "still_here" && c.answeredAt) stillHere.set(c.studentId, c.answeredAt);
  }

  for (const record of pending) {
    try {
      const { studentId } = record;
      const { startMin } = pickupWindow(record.student.session);
      const since = absentSince({
        lastFaceAt: latest.get(`${studentId}:face`)?.lastSeenAt,
        lastBleAt: latest.get(`${studentId}:ble`)?.lastSeenAt,
        stillHereAt: stillHere.get(studentId),
        arrivedAt: record.arrivedAt,
        windowStart: instantAtMinute(now, nowMinutes, startMin),
        unhealthyAt,
      });
      const action = decidePickupAction({ now, absentSince: since, lastCheck: lastCheck.get(studentId) ?? null });
      if (action === "pick_up") {
        await autoMarkPickedUp(studentId, today, now);
      } else if (action === "prompt") {
        await prisma.pickupCheck.create({
          data: { studentId, date: today, expiresAt: new Date(now.getTime() + PROMPT_TTL_MS) },
        });
      }
    } catch (err) {
      logger.error({ err, studentId: record.studentId }, "Pickup watch failed for a student");
    }
  }

  for (const record of autoPickedUp) {
    try {
      const face = latest.get(`${record.studentId}:face`);
      const ble = latest.get(`${record.studentId}:ble`);
      // Both signals must be new since the pickup AND pass the same test as arrival.
      if (!face || !ble || face.lastSeenAt <= record.pickedUpAt || ble.lastSeenAt <= record.pickedUpAt) continue;
      if (evaluate({ face, ble, now }) !== "verified") continue;
      const { count } = await prisma.attendance.updateMany({
        where: { id: record.id, pickedUpAuto: true, pickedUpAt: { not: null } },
        data: { pickedUpAt: null, pickedUpAuto: false },
      });
      if (count > 0) logger.info({ studentId: record.studentId }, "Automatic pickup undone: student seen again");
    } catch (err) {
      logger.error({ err, studentId: record.studentId }, "Pickup undo failed for a student");
    }
  }
}

// ---- the teacher's side (called by the controller) --------------------------

// `{ student: scope }` for a Teacher, nothing for an Admin (sees all), and a
// filter that matches nothing for any other role.
function studentFilterFor(user) {
  const scope = studentScopeFor(user) ?? { id: -1 };
  return Object.keys(scope).length > 0 ? { student: scope } : {};
}

// Open prompts the user may see: their center's students' (a Teacher), or all (Admin).
export async function listOpenPickupChecks(user, now = new Date()) {
  const today = schoolDateAsUtcMidnight(now);
  const rows = await prisma.pickupCheck.findMany({
    where: {
      date: today,
      answeredAt: null,
      expiresAt: { gt: now },
      ...studentFilterFor(user),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, studentId: true, expiresAt: true, student: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    studentId: r.studentId,
    name: r.student.name,
    // Remaining time rather than a timestamp: the browser's clock may be off.
    expiresInMs: Math.max(0, r.expiresAt.getTime() - now.getTime()),
  }));
}

// Records the teacher's answer. `user` must be allowed to act on the student
// (an Admin, or that student's teacher) — otherwise, like a missing or
// out-of-date prompt, it is "not_found", so ids can't be probed. Returns
// { outcome: "answered" | "expired" | "not_found" }; "expired" means it was
// already answered or its 15 s ran out.
export async function answerPickupCheck(user, checkId, stillHere, now = new Date()) {
  const today = schoolDateAsUtcMidnight(now);
  const check = await prisma.pickupCheck.findUnique({
    where: { id: checkId },
    select: { id: true, studentId: true, date: true },
  });
  if (!check || check.date.getTime() !== today.getTime()) return { outcome: "not_found" };
  try {
    await assertCanAccessStudent(user, check.studentId);
  } catch (err) {
    if (err?.status === 403) return { outcome: "not_found" };
    throw err;
  }

  const claimed = await prisma.pickupCheck.updateMany({
    where: { id: checkId, answeredAt: null, expiresAt: { gt: now } },
    data: { answeredAt: now, answer: stillHere ? "still_here" : "picked_up" },
  });
  if (claimed.count === 0) return { outcome: "expired" };

  if (!stillHere) await autoMarkPickedUp(check.studentId, today, now, { auto: false });
  return { outcome: "answered" };
}
