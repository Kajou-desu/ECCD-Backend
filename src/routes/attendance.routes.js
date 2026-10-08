import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  getAttendance,
  updateAttendance,
  recordAttendance,
  markDeparted,
} from "../controllers/attendance.controller.js";
import { getAttendanceRange, importAttendance } from "../controllers/attendanceBulk.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/", requireRole("Teacher", "Admin"), getAttendance);
// Declared before "/:studentId" routes so "range" / "import" are never read as ids.
router.get("/range", requireRole("Teacher", "Admin"), getAttendanceRange);
router.post("/import", requireRole("Teacher", "Admin"), importAttendance);
router.put("/:studentId", requireRole("Teacher", "Admin"), updateAttendance);
router.patch("/:studentId/depart", requireRole("Teacher", "Admin"), markDeparted);
router.post("/", requireRole("Teacher", "Admin"), recordAttendance);

export default router;
