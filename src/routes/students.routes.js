import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
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

router.get("/:id/ble-devices", requireRole("Teacher", "Admin"), listBleDevices);
router.post("/:id/ble-devices", requireRole("Teacher", "Admin"), addBleDevice);
router.patch("/:id/ble-devices/:deviceId", requireRole("Teacher", "Admin"), setBleDeviceEnabled);
router.delete("/:id/ble-devices/:deviceId", requireRole("Teacher", "Admin"), removeBleDevice);

router.get("/:childId/submissions", getSubmissions);
router.get("/:childId/attendance", getChildAttendance);
router.get("/:childId/progress", getChildProgress);

export default router;
