import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
	getEvents,
	createEvent,
	updateEvent,
	deleteEvent,
} from "../controllers/events.controller.js";

const router = Router();

// Read-only: viewing the school calendar is fine for parents/guardians too
// (it's school-wide info, not per-student data). Creating/editing/deleting
// events stays Teacher/Admin only, below.
router.get("/", requireAuth, requireRole("Teacher", "Admin", "Parent", "Guardian"), getEvents);
router.post("/", requireAuth, requireRole("Teacher", "Admin"), createEvent);
router.put("/:id", requireAuth, requireRole("Teacher", "Admin"), updateEvent);
router.delete("/:id", requireAuth, requireRole("Teacher", "Admin"), deleteEvent);

export default router;
