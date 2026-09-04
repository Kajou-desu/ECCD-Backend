import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import {
  getStudents,
  getStudent,
  createStudent,
  updateStudent,
  deleteStudent,
} from "../controllers/students.controller.js";
import { uploadStudentDocuments } from "../controllers/studentDocuments.controller.js";
import { getSubmissions } from "../controllers/submissions.controller.js";
import { getChildAttendance } from "../controllers/attendance.controller.js";
import { getChildProgress } from "../controllers/parent.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/", requireRole("Teacher", "Admin"), getStudents);
router.get("/:id", getStudent); // ownership enforced in controller (Parent/Guardian scoped to own children)
router.post("/", requireRole("Teacher", "Admin"), createStudent);
router.put("/:id", requireRole("Teacher", "Admin"), updateStudent);
router.delete("/:id", requireRole("Teacher", "Admin"), deleteStudent);
router.post(
  "/:id/documents",
  requireRole("Teacher", "Admin"),
  upload.array("documents", 10),
  uploadStudentDocuments
);

router.get("/:childId/submissions", getSubmissions);
router.get("/:childId/attendance", getChildAttendance);
router.get("/:childId/progress", getChildProgress);

export default router;
