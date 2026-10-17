import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { listNoClassDays, createNoClassDays, deleteNoClassDay } from "../controllers/noClassDays.controller.js";

const router = Router();

// Reading is fine for parents/guardians (school-wide info, like the events
// calendar). Changing it is Teacher/Admin only.
router.get("/", requireAuth, requireRole("Teacher", "Admin", "Parent", "Guardian"), listNoClassDays);
router.post("/", requireAuth, requireRole("Teacher", "Admin"), createNoClassDays);
router.delete("/:id", requireAuth, requireRole("Teacher", "Admin"), deleteNoClassDay);

export default router;
