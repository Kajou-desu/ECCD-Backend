import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { listCenters, createCenter, renameCenter } from "../controllers/centers.controller.js";

const router = Router();

router.use(requireAuth);
router.get("/", requireRole("Teacher", "Admin"), listCenters);
router.post("/", requireRole("Admin"), createCenter);
router.put("/:id", requireRole("Admin"), renameCenter);

export default router;
