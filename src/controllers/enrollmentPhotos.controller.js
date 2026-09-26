import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { parseId } from "../utils/validate.js";
import { isRecognitionConfigured, enrollStudentPhotos } from "../services/recognitionClient.js";

// Teacher/admin only (enforced at route level).
export const MAX_ENROLLMENT_PHOTOS = 8;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// multer only sees the client-declared mimetype, so the bytes are checked as
// well (same idea as src/middleware/upload.js's signature check).
function matchesDeclaredType(buffer, mimetype) {
  if (mimetype === "image/jpeg") {
    return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimetype === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC);
  }
  return false; // default deny
}

// POST /api/students/:id/enrollment-photos — multipart, field "photos"
// (1-MAX_ENROLLMENT_PHOTOS files). REPLACES this student's whole enrollment
// photo set on the face-recognition service.
//
// These are biometric photos of a child. They are held in memory only
// (multer memoryStorage), forwarded to the recognition service, and then
// dropped — never written to the app's own database or S3/local file
// storage, so they stay isolated the way face-recognition-service/README.md
// asks (guardian consent for enrolling a child is assumed to already be in
// place; this endpoint does not track or verify it).
export async function uploadEnrollmentPhotos(req, res, next) {
  try {
    if (!isRecognitionConfigured()) {
      return res.status(503).json({ message: "Face recognition is not configured" });
    }

    const id = parseId(req.params.id, "id");
    const files = req.files ?? [];
    if (files.length === 0) {
      return res.status(400).json({ message: "At least one photo is required" });
    }
    for (const file of files) {
      if (!matchesDeclaredType(file.buffer, file.mimetype)) {
        return res.status(400).json({ message: "Each photo must be a JPEG or PNG image" });
      }
    }

    const student = await prisma.student.findUnique({ where: { id }, select: { id: true } });
    if (!student) return res.status(404).json({ message: "Student not found" });

    let result;
    try {
      result = await enrollStudentPhotos(id, files);
    } catch (err) {
      logger.error({ err }, "Enrollment photo upload failed");
      return res.status(502).json({ message: "Face recognition service unavailable" });
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
}
