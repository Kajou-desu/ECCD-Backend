import { prisma } from "../lib/prisma.js";
import { findActiveSession } from "../lib/activeSession.js";
import { recordSignal } from "../services/attendanceVerification.service.js";

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

// Resolves sightings to students for the active session and feeds each one
// into the verification service. `req.body` has already
// been validated/normalised by gatewayEventsSchema. The response tells the
// gateway whether a session is running so it can idle when nothing is.
export async function postEvents(req, res, next) {
  try {
    const session = await findActiveSession();
    if (!session) {
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
      select: { deviceIdentifier: true, studentId: true },
    });
    const studentByDevice = new Map(devices.map((d) => [d.deviceIdentifier, d.studentId]));

    // Sequential on purpose: each sighting smooths into the previous one, so
    // two readings for the same student must not race each other.
    let accepted = 0;
    for (const event of events) {
      const studentId = studentByDevice.get(event.deviceIdentifier);
      if (studentId === undefined) continue; // not a registered tag: ignore
      await recordSignal({
        sessionId: session.id,
        sessionDate: session.date,
        studentId,
        kind: "ble",
        value: event.rssi,
      });
      accepted += 1;
    }
    res.json({ sessionActive: true, accepted });
  } catch (err) {
    next(err);
  }
}
