import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { centerKey, findActiveSession } from "../lib/activeSession.js";
import { schoolDateAsUtcMidnight } from "../utils/schoolDate.js";
import { isSignalPresent } from "../services/attendanceVerification.service.js";
import { isRecognitionConfigured } from "../services/recognitionClient.js";
import { isCameraAlive, isGatewayOnline } from "../lib/hardwareStatus.js";
import {
  findPickupOverride,
  pickupWatchStatus,
  pickupWindowStatus,
  presenceStatus,
  setPickupWatchRunning,
} from "../services/pickupWatch.service.js";
import { liveStudentScope } from "../utils/studentScope.js";
import { sessionCenterFor } from "../utils/sessionScope.js";
import { AppError } from "../middleware/errorHandler.js";

// Teacher/admin only (enforced at route level). The session's date comes from
// the server clock in the school's timezone, its owner from req.user (the
// verified token/DB record) and, for a Teacher, its center from req.user too, so
// a client can't choose any of them. Sessions are per center: every handler acts
// only on the caller's own center's session (see utils/sessionScope.js for the
// one case, an Admin, where the request names the center).

const SELECT = { id: true, date: true, status: true, startedAt: true, endedAt: true };

// startedById is deliberately not exposed — the UI has no use for it.
function toResponse(session) {
  if (!session) return null;
  return {
    id: session.id,
    date: session.date.toISOString().slice(0, 10),
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  };
}

const findActive = (centerId) => findActiveSession(centerId, SELECT);

// GET /attendance/session/current
//   -> { session: {...} | null, pickupWindow: { active, endsAt } }
// pickupWindow says whether automatic pickup tracking is running (the page uses
// it to start the camera).
export async function getCurrentSession(req, res, next) {
  try {
    // An Admin who has not named a center has no session to show (not an error:
    // the header polls this).
    const centerId = sessionCenterFor(req, { required: false, from: "query" });
    const session = centerId === undefined ? null : await findActive(centerId);
    res.json({
      session: toResponse(session),
      pickupWindow:
        centerId === undefined ? pickupWindowStatus() : pickupWatchStatus(new Date(), await findPickupOverride(centerId)),
    });
  } catch (err) {
    next(err);
  }
}

// POST /attendance/session/start
// Idempotent: if today's session is already active at the caller's center it is
// returned (200) rather than creating a second one, so a double-click or a
// second teacher device is harmless. A still-active session from a PREVIOUS day
// is closed first. Other centers' sessions are never touched.
export async function startSession(req, res, next) {
  try {
    const centerId = sessionCenterFor(req);
    const today = schoolDateAsUtcMidnight();

    const existing = await findActive(centerId);
    if (existing) {
      if (existing.date.getTime() === today.getTime()) {
        return res.json({ session: toResponse(existing) });
      }
      // Guarded on status so this can't close a session someone else just replaced.
      await prisma.attendanceSession.updateMany({
        where: { id: existing.id, status: "active" },
        data: { status: "closed", endedAt: new Date() },
      });
    }

    try {
      const created = await prisma.attendanceSession.create({
        data: { date: today, centerId, startedById: req.user.id },
        select: SELECT,
      });
      logger.info({ sessionId: created.id, userId: req.user.id, centerId }, "Attendance session started");
      return res.status(201).json({ session: toResponse(created) });
    } catch (err) {
      // Two starts raced and the database's one-active-session-per-center index
      // rejected ours (P2002). Return the winner instead of an error.
      if (err?.code === "P2002") {
        const winner = await findActive(centerId);
        if (winner) return res.json({ session: toResponse(winner) });
      }
      // An Admin named a center that doesn't exist (foreign key).
      if (err?.code === "P2003") throw new AppError("Center not found", 404);
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

// POST /attendance/session/stop -> { session: null }
// Stops only the caller's own center's session; other centers keep running.
// Idempotent: stopping when nothing is active is a no-op success.
export async function stopSession(req, res, next) {
  try {
    const centerId = sessionCenterFor(req);
    const { count } = await prisma.attendanceSession.updateMany({
      where: { status: "active", centerId },
      data: { status: "closed", endedAt: new Date() },
    });
    if (count > 0) {
      logger.info({ userId: req.user.id, centerId, count }, "Attendance session stopped");
    }
    res.json({ session: null });
  } catch (err) {
    next(err);
  }
}

// POST /attendance/session/pickup-watch/start | /stop -> { pickupWindow: { active, endsAt, mode } }
// The Live attendance page's Start/Stop auto pickup button. Acts only on the
// caller's own center (an Admin names it, see utils/sessionScope.js), and is
// idempotent. It records the choice only: the pickup job does the work.
function setPickupWatch(running) {
  return async (req, res, next) => {
    try {
      const centerId = sessionCenterFor(req);
      const pickupWindow = await setPickupWatchRunning(centerId, running);
      logger.info({ userId: req.user.id, centerId, running }, "Automatic pickup switched by a user");
      res.json({ pickupWindow });
    } catch (err) {
      // An Admin named a center that doesn't exist (foreign key).
      next(err?.code === "P2003" ? new AppError("Center not found", 404) : err);
    }
  };
}
export const startPickupWatch = setPickupWatch(true);
export const stopPickupWatch = setPickupWatch(false);

// GET /attendance/session/monitor — everything the live monitor screen needs in
// one call: who is verified, who has only one of the two signals so far, and
// whether the hardware side is alive. Students appear once they have at least
// one CURRENT signal; a signal that has gone stale simply drops off.
export async function getMonitor(req, res, next) {
  try {
    const scope = liveStudentScope(req.user);
    const centerId = sessionCenterFor(req, { required: false, from: "query" });
    const session = centerId === undefined ? null : await findActive(centerId);
    if (!session) return res.json({ session: null });

    const now = new Date();
    const today = schoolDateAsUtcMidnight(now);
    const [signals, verifications, gateway, presentToday] = await Promise.all([
      prisma.attendanceSignal.findMany({
        where: { sessionId: session.id, student: scope },
        select: {
          studentId: true,
          kind: true,
          score: true,
          hits: true,
          lastSeenAt: true,
          student: { select: { name: true } },
        },
      }),
      prisma.attendanceVerification.findMany({
        where: { sessionId: session.id, attendance: { student: scope } },
        select: {
          verifiedAt: true,
          attendance: { select: { studentId: true, student: { select: { name: true } } } },
        },
      }),
      isGatewayOnline(now),
      prisma.attendance.findMany({
        where: { date: today, status: "present", student: scope },
        select: { studentId: true, arrivedAt: true, stillHereAt: true, pickedUpAt: true, student: { select: { name: true } } },
      }),
    ]);

    const byStudent = new Map();
    const entry = (studentId, name) => {
      if (!byStudent.has(studentId)) {
        byStudent.set(studentId, { studentId, name, face: false, ble: false, verifiedAt: null });
      }
      return byStudent.get(studentId);
    };
    for (const sig of signals) {
      // "exit" sightings are the pickup camera's: they are not part of arrival.
      if (sig.kind === "exit") continue;
      if (isSignalPresent(sig.kind, sig, now)) entry(sig.studentId, sig.student.name)[sig.kind] = true;
    }
    for (const v of verifications) {
      entry(v.attendance.studentId, v.attendance.student.name).verifiedAt = v.verifiedAt;
    }

    const rank = { verified: 0, both_seen: 1, face_only: 2, ble_only: 3 };
    const students = [...byStudent.values()]
      .map(({ face, ble, ...rest }) => ({
        ...rest,
        // Both live signals but no verification row: the student already has a
        // record for today (e.g. marked by hand), which verification never overwrites.
        status: rest.verifiedAt ? "verified" : face && ble ? "both_seen" : face ? "face_only" : "ble_only",
      }))
      .sort(
        (a, b) =>
          rank[a.status] - rank[b.status] ||
          (b.verifiedAt?.getTime() ?? 0) - (a.verifiedAt?.getTime() ?? 0) ||
          a.name.localeCompare(b.name),
      );

    // The Present Students table: everyone marked present today, however they
    // got marked, and whether they are still inside. Silence only counts while
    // the gateway and this center's EXIT camera are both alive (see presenceStatus):
    // a student the exit camera could not have seen leaving is not "not detected".
    const entryCameraAlive = isCameraAlive(centerKey(centerId), now, "entry");
    const exitCameraAlive = isCameraAlive(centerKey(centerId), now, "exit");
    const detectionActive = gateway && exitCameraAlive;
    const lastSeen = new Map(); // `${studentId}:${kind}` -> newest sighting today, across sessions
    if (presentToday.length > 0) {
      const sightings = await prisma.attendanceSignal.findMany({
        where: { studentId: { in: presentToday.map((r) => r.studentId) }, session: { date: today } },
        select: { studentId: true, kind: true, lastSeenAt: true },
      });
      for (const s of sightings) {
        const key = `${s.studentId}:${s.kind}`;
        if (!lastSeen.has(key) || s.lastSeenAt > lastSeen.get(key)) lastSeen.set(key, s.lastSeenAt);
      }
    }
    const statusRank = { not_detected: 0, inside: 1, picked_up: 2 };
    const presentStudents = presentToday
      .map((r) => ({
        studentId: r.studentId,
        name: r.student.name,
        arrivedAt: r.arrivedAt,
        pickedUpAt: r.pickedUpAt,
        status: presenceStatus({
          now,
          pickedUpAt: r.pickedUpAt,
          detectionActive,
          lastFaceAt: lastSeen.get(`${r.studentId}:face`),
          lastBleAt: lastSeen.get(`${r.studentId}:ble`),
          lastExitAt: lastSeen.get(`${r.studentId}:exit`),
          stillHereAt: r.stillHereAt,
          arrivedAt: r.arrivedAt,
        }),
      }))
      .sort((a, b) => statusRank[a.status] - statusRank[b.status] || a.name.localeCompare(b.name));

    const count = (status) => students.filter((s) => s.status === status).length;
    res.json({
      session: toResponse(session),
      gatewayOnline: gateway,
      recognitionAvailable: isRecognitionConfigured(),
      counts: { verified: count("verified"), faceOnly: count("face_only"), bleOnly: count("ble_only") },
      students,
      detectionActive,
      cameras: { entry: entryCameraAlive, exit: exitCameraAlive },
      presentStudents,
    });
  } catch (err) {
    next(err);
  }
}
