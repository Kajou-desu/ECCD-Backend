import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  getAttendance,
  updateAttendance,
  recordAttendance,
  markPickedUp,
} from "../controllers/attendance.controller.js";
import { getAttendanceRange, importAttendance, deleteAttendance } from "../controllers/attendanceBulk.controller.js";
import { attendanceDeleteLimiter } from "../middleware/rateLimit.js";
import {
  auditAttendanceImport,
  auditAttendanceUpdate,
  auditAttendancePickup,
  auditAttendanceBulk,
  auditAttendanceDelete,
} from "../middleware/auditRoutes.js";

const router = Router();

router.use(requireAuth);

router.get("/", requireRole("Teacher", "Admin"), getAttendance);
// Declared before "/:studentId" routes so "range" / "import" / "delete" are never read as ids.
router.get("/range", requireRole("Teacher", "Admin"), getAttendanceRange);
router.post("/import", requireRole("Teacher", "Admin"), auditAttendanceImport, importAttendance);
router.post("/delete", requireRole("Teacher", "Admin"), attendanceDeleteLimiter, auditAttendanceDelete, deleteAttendance);
router.put("/:studentId", requireRole("Teacher", "Admin"), auditAttendanceUpdate, updateAttendance);
router.patch("/:studentId/pickup", requireRole("Teacher", "Admin"), auditAttendancePickup, markPickedUp);
router.post("/", requireRole("Teacher", "Admin"), auditAttendanceBulk, recordAttendance);

export default router;
