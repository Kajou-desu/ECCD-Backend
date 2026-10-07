import { Router } from "express";
import multer from "multer";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { AppError } from "../middleware/errorHandler.js";
import { parseId } from "../utils/validate.js";
import { assertCanAccessStudent } from "../utils/ownership.js";
import { enrollmentUserLimiter, enrollmentViewUserLimiter } from "../middleware/rateLimit.js";
import {
  getStudents,
  getStudent,
  createStudent,
  updateStudent,
  deleteStudent,
  importStudents,
  uploadStudentPhoto,
} from "../controllers/students.controller.js";
import { uploadStudentDocuments, deleteStudentDocument } from "../controllers/studentDocuments.controller.js";
import {
  uploadEnrollmentPhotos,
  getEnrollmentPhotoCount,
  getEnrollmentPhoto,
  deleteEnrollmentPhotos,
  MAX_ENROLLMENT_PHOTOS,
} from "../controllers/enrollmentPhotos.controller.js";
import { getSubmissions } from "../controllers/submissions.controller.js";
import { getChildAttendance } from "../controllers/attendance.controller.js";
import {
  listBleDevices,
  addBleDevice,
  setBleDeviceEnabled,
  removeBleDevice,
} from "../controllers/bleDevices.controller.js";
import { getChildProgress } from "../controllers/parent.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/", requireRole("Teacher", "Admin"), getStudents);
router.get("/:id", getStudent); // ownership enforced in controller (Parent/Guardian scoped to own children)
router.post("/", requireRole("Teacher", "Admin"), createStudent);
router.post("/import", requireRole("Teacher", "Admin"), importStudents);
router.put("/:id", requireRole("Teacher", "Admin"), updateStudent);
router.delete("/:id", requireRole("Teacher", "Admin"), deleteStudent);
router.post(
  "/:id/photo",
  requireRole("Teacher", "Admin"),
  upload.single("photo", { imagesOnly: true }),
  uploadStudentPhoto
);
router.post(
  "/:id/documents",
  requireRole("Teacher", "Admin"),
  upload.array("documents", 10),
  uploadStudentDocuments
);
router.delete("/:id/documents/:documentId", requireRole("Teacher", "Admin"), deleteStudentDocument);

// Enrollment photos (face recognition): biometric data of a child, so these
// stay in memory and go straight to the recognition service — never through
// the shared upload.js pipeline, which persists into the app's own storage.
const enrollmentPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per photo
    files: MAX_ENROLLMENT_PHOTOS,
    fields: 0,
    parts: MAX_ENROLLMENT_PHOTOS + 1,
  },
  // Reject, don't skip: cb(null, false) silently dropped the file, so with
  // 8 selected and one WEBP/HEIC the other 7 were enrolled (replacing the old
  // set) and the request still answered 200.
  fileFilter: (_req, file, cb) =>
    file.mimetype === "image/jpeg" || file.mimetype === "image/png"
      ? cb(null, true)
      : cb(new AppError("Each photo must be a JPEG or PNG image", 400)),
}).array("photos", MAX_ENROLLMENT_PHOTOS);

// multer buffers up to 8 x 10 MB in memory as soon as it runs, so the
// ownership decision has to come BEFORE it: otherwise any Teacher could make
// the server hold that much for any student id and only then be told 403.
// (The controller still checks too; this is the cheap early gate.)
async function authorizeEnrollmentTarget(req, _res, next) {
  try {
    await assertCanAccessStudent(req.user, parseId(req.params.id, "id"));
    next();
  } catch (err) {
    next(err);
  }
}

router.post(
  "/:id/enrollment-photos",
  requireRole("Teacher", "Admin"),
  enrollmentUserLimiter,
  authorizeEnrollmentTarget,
  enrollmentPhotoUpload,
  uploadEnrollmentPhotos
);
router.get(
  "/:id/enrollment-photos",
  requireRole("Teacher", "Admin"),
  enrollmentViewUserLimiter,
  getEnrollmentPhotoCount
);
router.delete(
  "/:id/enrollment-photos",
  requireRole("Teacher", "Admin"),
  enrollmentUserLimiter,
  deleteEnrollmentPhotos
);
router.get(
  "/:id/enrollment-photos/:index",
  requireRole("Teacher", "Admin"),
  enrollmentViewUserLimiter,
  getEnrollmentPhoto
);

router.get("/:id/ble-devices", requireRole("Teacher", "Admin"), listBleDevices);
router.post("/:id/ble-devices", requireRole("Teacher", "Admin"), addBleDevice);
router.patch("/:id/ble-devices/:deviceId", requireRole("Teacher", "Admin"), setBleDeviceEnabled);
router.delete("/:id/ble-devices/:deviceId", requireRole("Teacher", "Admin"), removeBleDevice);

router.get("/:childId/submissions", getSubmissions);
router.get("/:childId/attendance", getChildAttendance);
router.get("/:childId/progress", getChildProgress);

export default router;
