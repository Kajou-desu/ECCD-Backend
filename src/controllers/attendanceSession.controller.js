import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { findActiveSession } from "../lib/activeSession.js";
import { schoolDateAsUtcMidnight } from "../utils/schoolDate.js";
import { isSignalPresent } from "../services/attendanceVerification.service.js";
import { isRecognitionConfigured } from "../services/recognitionClient.js";

// Teacher/admin only (enforced at route level). None of these read anything
// from the request body: the session's date comes from the server clock in the
// school's timezone and its owner from req.user (the verified token/DB record),
// so a client can't choose either.

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

const findActive = () => findActiveSession(SELECT);

// GET /attendance/session/current -> { session: {...} | null }
export async function getCurrentSession(_req, res, next) {
  try {
    res.json({ session: toResponse(await findActive()) });
  } catch (err) {
    next(err);
  }
}

// POST /attendance/session/start
// Idempotent: if today's session is already active it is returned (200) rather
// than creating a second one, so a double-click or a second teacher device is
// harmless. A still-active session from a PREVIOUS day is closed first.
export async function startSession(req, res, next) {
  try {
    const today = schoolDateAsUtcMidnight();

    const existing = await findActive();
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
        data: { date: today, startedById: req.user.id },
        select: SELECT,
      });
      logger.info({ sessionId: created.id, userId: req.user.id }, "Attendance session started");
      return res.status(201).json({ session: toResponse(created) });
    } catch (err) {
      // Two starts raced and the database's one-active-session index rejected
      // ours (P2002). Return the winner instead of an error.
      if (err?.code === "P2002") {
        const winner = await findActive();
        if (winner) return res.json({ session: toResponse(winner) });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

// POST /attendance/session/stop -> { session: null }
// Idempotent: stopping when nothing is active is a no-op success.
export async function stopSession(req, res, next) {
  try {
    const { count } = await prisma.attendanceSession.updateMany({
      where: { status: "active" },
      data: { status: "closed", endedAt: new Date() },
    });
    if (count > 0) {
      logger.info({ userId: req.user.id, count }, "Attendance session stopped");
    }
    res.json({ session: null });
  } catch (err) {
    next(err);
  }
}

// A gateway that has been heard from this recently counts as online.
const GATEWAY_ONLINE_MS = 30_000;

// GET /attendance/session/monitor — everything the live monitor screen needs in
// one call: who is verified, who has only one of the two signals so far, and
// whether the hardware side is alive. Students appear once they have at least
// one CURRENT signal; a signal that has gone stale simply drops off.
export async function getMonitor(_req, res, next) {
  try {
    const session = await findActive();
    if (!session) return res.json({ session: null });

    const now = new Date();
    const [signals, verifications, gateway] = await Promise.all([
      prisma.attendanceSignal.findMany({
        where: { sessionId: session.id },
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
        where: { sessionId: session.id },
        select: {
          verifiedAt: true,
          attendance: { select: { studentId: true, student: { select: { name: true } } } },
        },
      }),
      prisma.bleGateway.findFirst({
        where: { enabled: true, lastSeenAt: { gt: new Date(now.getTime() - GATEWAY_ONLINE_MS) } },
        select: { id: true },
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
      if (isSignalPresent(sig.kind, sig, now)) entry(sig.studentId, sig.student.name)[sig.kind] = true;
    }
    for (const v of verifications) {
      entry(v.attendance.studentId, v.attendance.student.name).verifiedAt = v.verifiedAt;
    }

    const rank = { verified: 0, face_only: 1, ble_only: 2 };
    const students = [...byStudent.values()]
      .map(({ face, ble, ...rest }) => ({
        ...rest,
        status: rest.verifiedAt ? "verified" : face ? "face_only" : "ble_only",
      }))
      .sort(
        (a, b) =>
          rank[a.status] - rank[b.status] ||
          (b.verifiedAt?.getTime() ?? 0) - (a.verifiedAt?.getTime() ?? 0) ||
          a.name.localeCompare(b.name),
      );

    const count = (status) => students.filter((s) => s.status === status).length;
    res.json({
      session: toResponse(session),
      gatewayOnline: Boolean(gateway),
      recognitionAvailable: isRecognitionConfigured(),
      counts: { verified: count("verified"), faceOnly: count("face_only"), bleOnly: count("ble_only") },
      students,
    });
  } catch (err) {
    next(err);
  }
}
