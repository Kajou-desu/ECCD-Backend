import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { centerKey, findActiveSession, findActiveSessions, sessionsByCenter } from "../lib/activeSession.js";
import { isCameraAlive, isGatewayOnline } from "../lib/hardwareStatus.js";
import { schoolDateAsUtcMidnight, schoolMinutesOfDay } from "../utils/schoolDate.js";
import { notifyPickup } from "./attendanceNotification.service.js";

// Automatic pickup.
//
// The PRIMARY signal is the EXIT camera: during a pickup window (morning
// students from PICKUP_MORNING_START, afternoon students from
// PICKUP_AFTERNOON_START, for PICKUP_WINDOW_HOURS, or a window the teacher
// started by hand) a student whose face the exit camera recognises is marked
// picked up. That happens in the frame controller, through pickupCamera.service.js
// and autoMarkPickedUp below; this file owns the window rules it relies on.
//
// The BLE tag is the BACKUP, for a student the exit camera missed. During the same
// window, a present student with an enabled tag whose face AND tag have both
// gone unseen is checked on (the in-room face signal is only the entry
// camera's arrival sighting, so in practice this is the tag going quiet):
//
//   * after 3 minutes unseen the student shows as "Not Detected" in the Live
//     attendance table (see presenceStatus), where the teacher can mark them
//     picked up by hand, or press "Still here" to restart the unseen clock.
//     Nothing pops up: the table is the notification;
//   * after PICKUP_ABSENT_MIN (5) minutes unseen (and no "Still here") the student
//     is marked picked up automatically. Parents get the same notification as a manual pickup.
//
// An automatic pickup is never undone by the system. If the entry camera sees an
// automatically picked-up student again, the teachers get an in-app notification
// (pickupCamera.service.js) and decide.
//
// Silence is weak evidence, so the backup does nothing unless the ESP32 gateway
// AND the EXIT camera are demonstrably alive, and the clock restarts after any
// outage. Every center is watched on its own: its students, its session, its
// camera and its outage clock, so one center's dead camera never pauses (and one
// center's live camera never vouches for) another's.
// The decisions are pure functions; runPickupWatch is the database wrapper.

// How long neither signal may go unseen before a present student shows as "Not Detected".
export const NOT_DETECTED_AFTER_MS = 3 * 60_000;
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

// ---- the teacher's manual Start / Stop ---------------------------------------
//
// An override is one row per center per day (see PickupWatchOverride):
//   * "off" (Stop) pauses the scheduled window that was open when it was pressed;
//     a window that opens later (afternoon) is unaffected;
//   * "on" (Start) opens a window of its own: it lasts PICKUP_WINDOW_HOURS from
//     when it was pressed, covers every watched student, and silence is only
//     counted from that moment (so resuming never marks anyone for the pause).

// When the scheduled window now open began, or null when none is open.
export function scheduledWindowStart(now = new Date(), cfg = env.pickup) {
  const nowMinutes = schoolMinutesOfDay(now);
  const open = sessionsInWindow(nowMinutes, cfg);
  if (open.length === 0) return null;
  return instantAtMinute(now, nowMinutes, Math.min(...open.map((s) => pickupWindow(s, cfg).startMin)));
}

export function isManualWindowOpen(override, now = new Date(), cfg = env.pickup) {
  return override?.mode === "on" && override.setAt.getTime() + cfg.windowMs > now.getTime();
}

export function isScheduledWindowPaused(override, scheduledStart) {
  return override?.mode === "off" && scheduledStart != null && override.setAt >= scheduledStart;
}

// Is a student of this class session ("morning" | "afternoon") inside an open
// pickup window right now? The same rules runPickupWatch applies, for one
// student: a window the teacher started covers everyone; otherwise the
// scheduled window of the student's own session counts unless a teacher has
// stopped it. `override` is that center's row for today (or null).
export function pickupWindowCovers(override, studentSession, now = new Date(), cfg = env.pickup) {
  if (isManualWindowOpen(override, now, cfg)) return true;
  const nowMinutes = schoolMinutesOfDay(now);
  if (!sessionsInWindow(nowMinutes, cfg).includes(studentSession)) return false;
  return !isScheduledWindowPaused(override, scheduledWindowStart(now, cfg));
}

// What the Live attendance page shows: is tracking running right now, until when,
// and which mode got it there ("auto" = the schedule, "on"/"off" = the teacher).
export function pickupWatchStatus(now = new Date(), override = null, cfg = env.pickup) {
  const scheduled = pickupWindowStatus(now, cfg);
  if (isManualWindowOpen(override, now, cfg)) {
    const manualEnd = new Date(override.setAt.getTime() + cfg.windowMs);
    const endsAt = scheduled.active && scheduled.endsAt > manualEnd ? scheduled.endsAt : manualEnd;
    return { active: true, endsAt, mode: "on" };
  }
  if (isScheduledWindowPaused(override, scheduledWindowStart(now, cfg))) {
    return { active: false, endsAt: null, mode: "off" };
  }
  return { ...scheduled, mode: "auto" };
}

// Today's overrides, centerKey -> { mode, setAt }.
async function loadPickupOverrides(today) {
  const rows = await prisma.pickupWatchOverride.findMany({
    where: { date: today },
    select: { centerId: true, mode: true, setAt: true },
  });
  return new Map(rows.map((r) => [centerKey(r.centerId), { mode: r.mode, setAt: r.setAt }]));
}

export function findPickupOverride(centerId, now = new Date()) {
  return prisma.pickupWatchOverride.findFirst({
    where: { date: schoolDateAsUtcMidnight(now), centerId: centerKey(centerId) },
    select: { mode: true, setAt: true },
  });
}

async function saveOverride(centerId, mode, now) {
  const date = schoolDateAsUtcMidnight(now);
  const key = centerKey(centerId);
  const data = { mode, setAt: now };
  const existing = await prisma.pickupWatchOverride.findFirst({ where: { date, centerId: key }, select: { id: true } });
  if (existing) {
    await prisma.pickupWatchOverride.updateMany({ where: { id: existing.id }, data });
    return;
  }
  try {
    await prisma.pickupWatchOverride.create({ data: { date, centerId: key, ...data } });
  } catch (err) {
    // Two presses raced and the one-row-per-center-per-day index rejected ours:
    // the other row exists now, so make it say what this press asked for.
    if (err?.code !== "P2002") throw err;
    await prisma.pickupWatchOverride.updateMany({ where: { date, centerId: key }, data });
  }
}

// Idempotent, so a double-click or a second device is harmless: starting when
// tracking already runs (or stopping when it doesn't) changes nothing, and
// never restarts anyone's unseen clock. Returns the status after the change.
export async function setPickupWatchRunning(centerId, running, now = new Date()) {
  const current = pickupWatchStatus(now, await findPickupOverride(centerId, now));
  if (current.active === running) return current;
  await saveOverride(centerId, running ? "on" : "off", now);
  return pickupWatchStatus(now, await findPickupOverride(centerId, now));
}

const latestOf = (dates) => dates.filter(Boolean).reduce((a, b) => (b > a ? b : a), new Date(0));

// When the current continuous "neither face nor tag seen" stretch began: the
// latest of the last sighting by either signal (or the exit camera), a teacher's
// "Still here", the student's arrival, the start of the window, and the end of the
// last hardware outage.
export function absentSince({ lastFaceAt, lastBleAt, lastExitAt, stillHereAt, arrivedAt, windowStart, unhealthyAt }) {
  return latestOf([lastFaceAt, lastBleAt, lastExitAt, stillHereAt, arrivedAt, windowStart, unhealthyAt]);
}

// "wait" | "pick_up".
export function decidePickupAction({ now, absentSince: since, cfg = env.pickup }) {
  return now.getTime() - since.getTime() >= cfg.absentMs ? "pick_up" : "wait";
}

// What the Live attendance table shows for a PRESENT student: "picked_up",
// "not_detected" (neither face nor tag seen for NOT_DETECTED_AFTER_MS, counted
// the same way as the pickup watch counts absence) or "inside". `detectionActive`
// is false while the gateway or the camera is down: silence proves nothing then,
// so nobody is called "not_detected".
export function presenceStatus({ now, pickedUpAt, detectionActive, ...signals }) {
  if (pickedUpAt) return "picked_up";
  if (!detectionActive) return "inside";
  return now.getTime() - absentSince(signals).getTime() >= NOT_DETECTED_AFTER_MS ? "not_detected" : "inside";
}

// When this center's hardware last looked down (or the process started), so the
// table counts silence the same way the watch does.
export const unhealthySinceFor = (centerId) => unhealthyAtFor(centerKey(centerId));

// ---- shared writes ----------------------------------------------------------

// Marks today's record picked up unless it already is (or isn't "present").
// Race-safe: the guarded updateMany lets only one caller win, and only the
// winner notifies parents. Returns whether this call did it. `source` is for the
// log only: "exit_camera" (primary) or "silence" (the BLE backup).
export async function autoMarkPickedUp(studentId, today, now = new Date(), source = "silence") {
  const { count } = await prisma.attendance.updateMany({
    where: { studentId, date: today, status: "present", arrivedAt: { not: null }, pickedUpAt: null },
    // A new automatic pickup may need a new "seen at the entrance again" alert.
    data: { pickedUpAt: now, pickedUpAuto: true, pickupReturnAlertedAt: null },
  });
  if (count === 0) return false;
  logger.info({ studentId, source }, "Student marked picked up automatically");
  // Fire-and-forget, same as the manual path: a failed SMS must not undo this.
  Promise.resolve()
    .then(() => notifyPickup(studentId, now))
    .catch(() => {});
  return true;
}

// ---- the periodic job -------------------------------------------------------

// Start of the current "everything has been healthy" stretch, per center;
// absence is never counted from before it. Starts at process start (a restart
// is an outage too).
let healthySince = new Date();
const unhealthyAt = new Map(); // centerKey -> when that center's hardware last looked down
const unhealthyAtFor = (key) => unhealthyAt.get(key) ?? healthySince;
export function resetPickupHealth(date = new Date()) {
  healthySince = date;
  unhealthyAt.clear();
}

const SESSION_SELECT = {
  id: true,
  date: true,
  centerId: true,
  autoStarted: true,
  startedAt: true,
  stopReminderSentAt: true,
};

// `windowStart` is when the current window opened. A pickup session that was
// already stopped since then at this center (by a teacher, or because everyone
// was picked up) is not started again — Stop must mean stop — so null comes back.
async function ensureAutoSession(today, session, windowStart, centerId) {
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
    where: { date: today, centerId, autoStarted: true, status: "closed", endedAt: { gte: windowStart } },
    select: { id: true },
  });
  if (stopped) return null;
  try {
    const created = await prisma.attendanceSession.create({
      data: { date: today, centerId, startedById: null, autoStarted: true },
      select: SESSION_SELECT,
    });
    logger.info({ sessionId: created.id, centerId }, "Attendance session auto-started for pickup tracking");
    return created;
  } catch (err) {
    // Lost a race with a teacher pressing Start (database allows one active session per center).
    if (err?.code === "P2002") return findActiveSession(centerId, SESSION_SELECT);
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

    // Only this session's center: another center's students are not its business.
    const rows = await prisma.attendance.findMany({
      where: {
        date: today,
        status: "present",
        student: { session: type, teacherId: { not: null }, teacher: { centerId: centerKey(session.centerId) } },
      },
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

  const sessions = sessionsByCenter(await findActiveSessions(SESSION_SELECT));
  for (const session of sessions.values()) await sendStopReminder(session, today, now, nowMinutes);

  const types = sessionsInWindow(nowMinutes);
  const overrides = await loadPickupOverrides(today);
  // Centers whose teacher pressed Start: tracked for every student, from that moment.
  const manualStart = new Map();
  for (const [key, override] of overrides) if (isManualWindowOpen(override, now)) manualStart.set(key, override.setAt);
  if (types.length === 0 && manualStart.size === 0) return;

  // Present students in the window, picked up or not. Every one of them keeps the
  // pickup session (and so the exit camera) running; only those with an enabled
  // tag are also judged by the BLE backup, since without a tag silence can't be
  // judged and the exit camera or a teacher is the only way they are picked up.
  const records = await prisma.attendance.findMany({
    where: {
      date: today,
      status: "present",
      arrivedAt: { not: null },
      student: {
        status: "active",
        session: { in: manualStart.size > 0 ? SESSIONS : types },
      },
    },
    select: {
      id: true,
      studentId: true,
      arrivedAt: true,
      stillHereAt: true,
      pickedUpAt: true,
      pickedUpAuto: true,
      student: {
        select: {
          session: true,
          teacher: { select: { centerId: true } },
          bleDevices: { where: { enabled: true }, select: { id: true }, take: 1 },
        },
      },
    },
  });
  const scheduledStart = types.length > 0 ? scheduledWindowStart(now) : null;

  // Each center is judged on its own. A center whose last student was just
  // picked up has no records any more but may still have a session of ours to close.
  // A center whose teacher pressed Stop keeps its scheduled students out of the
  // list (nothing is prompted or marked) and its session is left as it is.
  const byCenter = new Map();
  const paused = new Set();
  for (const record of records) {
    const key = centerKey(record.student.teacher?.centerId);
    let windowStart;
    if (manualStart.has(key)) {
      windowStart = manualStart.get(key);
    } else if (types.includes(record.student.session)) {
      if (isScheduledWindowPaused(overrides.get(key), scheduledStart)) {
        paused.add(key);
        continue;
      }
      windowStart = instantAtMinute(now, nowMinutes, pickupWindow(record.student.session).startMin);
    } else {
      continue;
    }
    byCenter.set(key, [...(byCenter.get(key) ?? []), { ...record, windowStart }]);
  }
  for (const key of sessions.keys()) if (!byCenter.has(key)) byCenter.set(key, []);
  for (const key of sessions.keys()) {
    if (isScheduledWindowPaused(overrides.get(key), scheduledStart) && !manualStart.has(key)) paused.add(key);
  }

  for (const [key, centerRecords] of byCenter) {
    try {
      await watchCenter({
        key,
        records: centerRecords,
        session: sessions.get(key) ?? null,
        today,
        now,
        windowStart: manualStart.get(key) ?? scheduledStart,
        paused: paused.has(key),
      });
    } catch (err) {
      // One center failing must not stop the others being watched.
      logger.error({ err, centerId: key }, "Pickup watch failed for a center");
    }
  }
}

// One center's share of the periodic job. `session` is that center's active
// session (or null).
async function watchCenter({ key, records, session, today, now, windowStart, paused }) {
  const pending = records.filter((r) => !r.pickedUpAt);

  // No teacher has to press Start: the ESP32 only scans, and the camera only
  // sends frames, while a session is active.
  if (pending.length > 0) {
    session = await ensureAutoSession(today, session, windowStart, key);
  } else if (session?.autoStarted && !paused) {
    // Everyone is picked up: end the session this job started, which also
    // turns the teacher's camera off (the live page stops it with the session).
    await prisma.attendanceSession.updateMany({
      where: { id: session.id, status: "active" },
      data: { status: "closed", endedAt: now },
    });
    logger.info({ sessionId: session.id }, "Pickup tracking finished: session closed");
  }
  if (records.length === 0) return;

  // The backup judges silence, so both the tag reader and the EXIT camera must be
  // demonstrably alive: a dead exit camera means a child could have left unseen
  // by it, and a dead reader means the tag could not be heard.
  if (!session || !(await isGatewayOnline(now)) || !isCameraAlive(key, now, "exit")) {
    unhealthyAt.set(key, now); // never count silence while the eyes were closed
    return;
  }

  // Only students with a tag can be judged by silence.
  const tagged = pending.filter((r) => r.student.bleDevices.length > 0);
  if (tagged.length === 0) return;
  const ids = tagged.map((r) => r.studentId);
  const signals = await prisma.attendanceSignal.findMany({
    where: { studentId: { in: ids }, session: { date: today } },
    select: { studentId: true, kind: true, score: true, hits: true, lastSeenAt: true },
  });

  // Newest sighting per (student, kind) across today's sessions.
  const latest = new Map();
  for (const s of signals) {
    const key = `${s.studentId}:${s.kind}`;
    if (!latest.has(key) || s.lastSeenAt > latest.get(key).lastSeenAt) latest.set(key, s);
  }

  for (const record of tagged) {
    try {
      const { studentId } = record;
      // A single exit-camera sighting is not enough to pick up (that takes
      // VERIFY_MIN_HITS), but it does show the student near the door, so it
      // restarts the clock: the backup is for a student the exit camera MISSED.
      const since = absentSince({
        lastFaceAt: latest.get(`${studentId}:face`)?.lastSeenAt,
        lastBleAt: latest.get(`${studentId}:ble`)?.lastSeenAt,
        lastExitAt: latest.get(`${studentId}:exit`)?.lastSeenAt,
        stillHereAt: record.stillHereAt,
        arrivedAt: record.arrivedAt,
        windowStart: record.windowStart,
        unhealthyAt: unhealthyAtFor(key),
      });
      if (decidePickupAction({ now, absentSince: since }) === "pick_up") {
        await autoMarkPickedUp(studentId, today, now, "silence");
      }
    } catch (err) {
      logger.error({ err, studentId: record.studentId }, "Pickup watch failed for a student");
    }
  }
}
