import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { parseId } from "../utils/validate.js";
import {
  isRecognitionConfigured,
  enrollStudentPhotos,
  countStudentEnrollmentPhotos,
  fetchStudentEnrollmentPhoto,
  removeStudentEnrollment,
  RecognitionRejectedError,
  RecognitionStaleError,
} from "../services/recognitionClient.js";
import { assertCanAccessStudent } from "../utils/ownership.js";

// Teacher/admin only (enforced at route level); a Teacher is further
// restricted to their own connected students.
export const MAX_ENROLLMENT_PHOTOS = 8;
// The service keeps at most this many images per student folder.
const MAX_STORED_PHOTOS = 20;

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
    await assertCanAccessStudent(req.user, id);
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
      if (err instanceof RecognitionRejectedError) {
        // Nothing was replaced: the student's previous enrollment (if any) is intact.
        return res.status(422).json({ message: "No photo contained exactly one clear face" });
      }
      logger.error({ err }, "Enrollment photo upload failed");
      return res.status(502).json({ message: "Face recognition service unavailable" });
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
}

// GET /api/students/:id/enrollment-photos — how many photos are enrolled, plus
// a version of that set (see getEnrollmentPhoto).
// Teacher/admin only (route level) + the same per-student check as uploading.
export async function getEnrollmentPhotoCount(req, res, next) {
  try {
    if (!isRecognitionConfigured()) {
      return res.status(503).json({ message: "Face recognition is not configured" });
    }
    const id = parseId(req.params.id, "id");
    await assertCanAccessStudent(req.user, id);

    try {
      const { count, version } = await countStudentEnrollmentPhotos(id);
      res.set("Cache-Control", "no-store");
      // `version` pins the per-photo requests that follow to this exact set.
      return res.json(version ? { count, version } : { count });
    } catch (err) {
      logger.error({ err }, "Enrollment photo count failed");
      return res.status(502).json({ message: "Face recognition service unavailable" });
    }
  } catch (err) {
    next(err);
  }
}

// GET /api/students/:id/enrollment-photos/:index — one enrolled photo, streamed
// from the recognition service. Biometric data of a child: never cached, never
// copied into the app's own storage, and only ever sent to an authorised
// teacher/admin. The bytes are re-checked so the service can't make this
// endpoint serve anything but a real JPEG/PNG.
export async function getEnrollmentPhoto(req, res, next) {
  try {
    if (!isRecognitionConfigured()) {
      return res.status(503).json({ message: "Face recognition is not configured" });
    }
    const id = parseId(req.params.id, "id");
    await assertCanAccessStudent(req.user, id);

    if (!/^\d{1,2}$/.test(req.params.index) || Number(req.params.index) >= MAX_STORED_PHOTOS) {
      return res.status(400).json({ message: "Invalid photo index" });
    }

    // Optional: the version returned by the count endpoint. When given, a photo
    // is served only if the set is still the one that was listed; otherwise
    // 409 and the client lists again, instead of showing a mix of two sets.
    const version = req.query.v;
    if (version !== undefined && (typeof version !== "string" || !/^[0-9a-f]{16}$/.test(version))) {
      return res.status(400).json({ message: "Invalid version" });
    }

    let photo;
    try {
      photo = await fetchStudentEnrollmentPhoto(id, Number(req.params.index), version);
    } catch (err) {
      if (err instanceof RecognitionStaleError) {
        return res.status(409).json({ message: "The photos changed. Reload and try again." });
      }
      logger.error({ err }, "Enrollment photo fetch failed");
      return res.status(502).json({ message: "Face recognition service unavailable" });
    }
    if (!photo) return res.status(404).json({ message: "Photo not found" });
    if (!matchesDeclaredType(photo.buffer, photo.contentType)) {
      logger.error("Recognition service returned bytes that do not match the image type");
      return res.status(502).json({ message: "Face recognition service unavailable" });
    }

    res.set({
      "Content-Type": photo.contentType,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    return res.send(photo.buffer);
  } catch (err) {
    next(err);
  }
}

// DELETE /api/students/:id/enrollment-photos — erases this student's enrolled
// face photos and encoding from the recognition service (biometric data of a
// child). Same route-level role gate and per-student check as the other
// enrollment routes. Idempotent: 204 whether or not anything was enrolled.
export async function deleteEnrollmentPhotos(req, res, next) {
  try {
    if (!isRecognitionConfigured()) {
      return res.status(503).json({ message: "Face recognition is not configured" });
    }
    const id = parseId(req.params.id, "id");
    await assertCanAccessStudent(req.user, id);

    try {
      await removeStudentEnrollment(id);
    } catch (err) {
      logger.error({ err }, "Enrollment photo removal failed");
      return res.status(502).json({ message: "Face recognition service unavailable" });
    }
    return res.status(204).end();
  } catch (err) {
    next(err);
  }
}
