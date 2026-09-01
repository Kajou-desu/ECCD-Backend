import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  getStudents,
  getStudent,
  createStudent,
  updateStudent,
  deleteStudent,
} from "../controllers/students.controller.js";
import { getSubmissions } from "../controllers/submissions.controller.js";
import { getChildAttendance } from "../controllers/attendance.controller.js";
import { getChildProgress } from "../controllers/parent.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/", requireRole("TEACHER", "ADMIN"), getStudents);
router.get("/:id", getStudent); // ownership enforced in controller (PARENT scoped to own children)
router.post("/", requireRole("TEACHER", "ADMIN"), createStudent);
router.put("/:id", requireRole("TEACHER", "ADMIN"), updateStudent);
router.delete("/:id", requireRole("TEACHER", "ADMIN"), deleteStudent);

router.get("/:childId/submissions", getSubmissions);
router.get("/:childId/attendance", getChildAttendance);
router.get("/:childId/progress", getChildProgress);

export default router;
