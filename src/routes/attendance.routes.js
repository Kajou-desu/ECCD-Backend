import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  getAttendance,
  updateAttendance,
  recordAttendance,
} from "../controllers/attendance.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/", getAttendance);
router.put("/:studentId", requireRole("TEACHER", "ADMIN"), updateAttendance);
router.post("/", requireRole("TEACHER", "ADMIN"), recordAttendance);

export default router;
