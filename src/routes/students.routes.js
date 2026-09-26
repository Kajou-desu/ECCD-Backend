import { Router } from "express";
import multer from "multer";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { enrollmentUserLimiter } from "../middleware/rateLimit.js";
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
import { uploadEnrollmentPhotos, MAX_ENROLLMENT_PHOTOS } from "../controllers/enrollmentPhotos.controller.js";
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
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "image/jpeg" || file.mimetype === "image/png"),
}).array("photos", MAX_ENROLLMENT_PHOTOS);

router.post(
  "/:id/enrollment-photos",
  requireRole("Teacher", "Admin"),
  enrollmentUserLimiter,
  enrollmentPhotoUpload,
  uploadEnrollmentPhotos
);

router.get("/:id/ble-devices", requireRole("Teacher", "Admin"), listBleDevices);
router.post("/:id/ble-devices", requireRole("Teacher", "Admin"), addBleDevice);
router.patch("/:id/ble-devices/:deviceId", requireRole("Teacher", "Admin"), setBleDeviceEnabled);
router.delete("/:id/ble-devices/:deviceId", requireRole("Teacher", "Admin"), removeBleDevice);

router.get("/:childId/submissions", getSubmissions);
router.get("/:childId/attendance", getChildAttendance);
router.get("/:childId/progress", getChildProgress);

export default router;
