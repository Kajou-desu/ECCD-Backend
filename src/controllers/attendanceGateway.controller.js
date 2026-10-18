import { prisma } from "../lib/prisma.js";
import { centerKey, findActiveSessions, sessionsByCenter } from "../lib/activeSession.js";
import { recordSignal } from "../services/attendanceVerification.service.js";
import { mapWithLimit, SIGNAL_CONCURRENCY } from "../utils/concurrency.js";

// Gateway-key authenticated (see routes/attendanceGateway.routes.js). These
// handlers never read who the student is from the request: the gateway only
// names a tag, and the server maps tag -> student from its own registry.

// The tags the gateway should listen for. MAC strings only — no student names,
// ids or any other student data ever reaches the device. Disabled tags and
// inactive students are left out.
export async function getRegistry(_req, res, next) {
  try {
    const rows = await prisma.studentBleDevice.findMany({
      where: { enabled: true, student: { status: "active" } },
      select: { deviceIdentifier: true },
      orderBy: { id: "asc" },
    });
    res.json({ devices: rows.map((r) => r.deviceIdentifier) });
  } catch (err) {
    next(err);
  }
}

// Resolves sightings to students and feeds each one into the verification
// service of THEIR center's active session (sessions are per center; the
// gateway itself isn't tied to one). `req.body` has already been
// validated/normalised by gatewayEventsSchema. The response tells the gateway
// whether any session is running so it can idle when nothing is.
export async function postEvents(req, res, next) {
  try {
    const sessions = sessionsByCenter(await findActiveSessions());
    if (sessions.size === 0) {
      return res.json({ sessionActive: false, accepted: 0 });
    }

    const { events } = req.body;
    if (events.length === 0) {
      return res.json({ sessionActive: true, accepted: 0 }); // heartbeat
    }

    const devices = await prisma.studentBleDevice.findMany({
      where: {
        deviceIdentifier: { in: [...new Set(events.map((e) => e.deviceIdentifier))] },
        enabled: true,
        student: { status: "active" },
      },
      select: {
        deviceIdentifier: true,
        studentId: true,
        student: { select: { teacher: { select: { centerId: true } } } },
      },
    });
    // tag -> student, and student -> the session of their center. A tag whose
    // center has no session running is ignored, like an unregistered one.
    const studentByDevice = new Map();
    const sessionByStudent = new Map();
    for (const d of devices) {
      const session = sessions.get(centerKey(d.student?.teacher?.centerId));
      if (!session) continue;
      studentByDevice.set(d.deviceIdentifier, d.studentId);
      sessionByStudent.set(d.studentId, session);
    }

    // One student's readings stay in order (each smooths into the previous
    // one, so two readings for the same student must not race each other —
    // a student can carry more than one tag). Different students touch
    // different rows, so they are recorded together instead of one after the
    // other: the gateway waits for this reply before its next scan.
    const byStudent = new Map();
    for (const event of events) {
      const studentId = studentByDevice.get(event.deviceIdentifier);
      if (studentId === undefined) continue; // not a registered tag: ignore
      byStudent.set(studentId, [...(byStudent.get(studentId) ?? []), event.rssi]);
    }
    const groups = [...byStudent.entries()];
    await mapWithLimit(groups, SIGNAL_CONCURRENCY, async ([studentId, readings]) => {
      const session = sessionByStudent.get(studentId);
      for (const rssi of readings) {
        await recordSignal({ sessionId: session.id, sessionDate: session.date, studentId, kind: "ble", value: rssi });
      }
    });
    const accepted = groups.reduce((sum, [, readings]) => sum + readings.length, 0);
    res.json({ sessionActive: true, accepted });
  } catch (err) {
    next(err);
  }
}
