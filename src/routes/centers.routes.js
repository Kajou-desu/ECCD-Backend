import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { listCenters, createCenter, renameCenter } from "../controllers/centers.controller.js";
import { auditCenterCreate, auditCenterRename } from "../middleware/auditRoutes.js";

const router = Router();

router.use(requireAuth);
router.get("/", requireRole("Teacher", "Admin"), listCenters);
router.post("/", requireRole("Admin"), auditCenterCreate, createCenter);
router.put("/:id", requireRole("Admin"), auditCenterRename, renameCenter);

export default router;
