import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { findActiveSession } from "../lib/activeSession.js";
import { recordSignal } from "../services/attendanceVerification.service.js";
import { isRecognitionConfigured, recognizeFrame } from "../services/recognitionClient.js";

// POST /attendance/session/frame — Teacher/Admin only, multipart field "frame".
// The frame lives in memory only (multer memoryStorage); it is never written to
// disk or logged, and is forwarded to the recognition service and dropped.

// JPEG files begin FF D8 FF. multer only sees the client-declared mimetype, so
// the bytes are checked as well (same idea as the upload middleware).
export function isJpeg(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

// Is this face a confident, unambiguous match under the backend's thresholds?
export function isConfidentMatch(face, cfg = env.verification) {
  if (face.studentId === null || face.distance === null) return false;
  if (face.distance > cfg.faceMaxDistance) return false;
  // margin === null means only one student is enrolled, so there is no
  // look-alike to be confused with. Otherwise the winner must clearly beat the runner-up.
  return face.margin === null || face.margin >= cfg.faceMinMargin;
}

export async function processFrame(req, res, next) {
  try {
    if (!isRecognitionConfigured()) {
      return res.status(503).json({ message: "Recognition unavailable" });
    }

    const session = await findActiveSession();
    if (!session) {
      return res.status(409).json({ message: "No active attendance session" });
    }

    if (!req.file) return res.status(400).json({ message: "A frame is required" });
    if (!isJpeg(req.file.buffer)) return res.status(400).json({ message: "Frame must be a JPEG image" });

    let result;
    try {
      result = await recognizeFrame(req.file.buffer);
    } catch (err) {
      // Detail stays in the server log; the client only learns it's unavailable.
      logger.error({ err }, "Face recognition request failed");
      return res.status(502).json({ message: "Recognition unavailable" });
    }

    // One student appearing as two faces in the same frame is impossible, so
    // it means at least one is a mis-match: trust neither.
    const counts = new Map();
    for (const f of result.faces) {
      if (f.studentId !== null) counts.set(f.studentId, (counts.get(f.studentId) ?? 0) + 1);
    }
    const candidates = result.faces.filter((f) => isConfidentMatch(f) && counts.get(f.studentId) === 1);

    const students = candidates.length
      ? await prisma.student.findMany({
          where: { id: { in: candidates.map((f) => f.studentId) }, status: "active" },
          select: { id: true, name: true },
        })
      : [];
    const studentById = new Map(students.map((s) => [s.id, s]));

    const verified = [];
    const verifiedIds = new Set();
    const now = new Date();
    for (const face of candidates) {
      const student = studentById.get(face.studentId);
      if (!student) continue; // unknown or inactive student: ignore
      // Sequential: each sighting smooths into the previous one.
      const outcome = await recordSignal({
        sessionId: session.id,
        sessionDate: session.date,
        studentId: student.id,
        kind: "face",
        value: face.distance,
        now,
      });
      if (outcome.state === "verified") {
        verified.push({ studentId: student.id, name: student.name, arrivedAt: outcome.arrivedAt });
        verifiedIds.add(student.id);
      }
    }

    // Names are returned only for confident matches — an unrecognised or
    // ambiguous face is reported as just a box.
    const faces = result.faces.map((f) => {
      const student = candidates.includes(f) ? studentById.get(f.studentId) : undefined;
      return {
        box: f.box,
        student: student ? { id: student.id, name: student.name } : null,
        verified: student ? verifiedIds.has(student.id) : false,
      };
    });

    res.json({ width: result.width, height: result.height, faces, verified });
  } catch (err) {
    next(err);
  }
}
