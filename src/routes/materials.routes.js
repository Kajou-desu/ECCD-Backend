import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import {
  getMaterials,
  createMaterial,
  updateMaterial,
  deleteMaterial,
} from "../controllers/materials.controller.js";
import { getMaterialSubmissions } from "../controllers/submissions.controller.js";
import { auditMaterialCreate, auditMaterialUpdate, auditMaterialDelete } from "../middleware/auditRoutes.js";

const router = Router();

router.use(requireAuth);

router.get("/", getMaterials);
router.get("/:id/submissions", requireRole("Teacher", "Admin"), getMaterialSubmissions);
router.post("/", requireRole("Teacher", "Admin"), upload.single("file"), auditMaterialCreate, createMaterial);
router.put("/:id", requireRole("Teacher", "Admin"), upload.single("file"), auditMaterialUpdate, updateMaterial);
router.delete("/:id", requireRole("Teacher", "Admin"), auditMaterialDelete, deleteMaterial);

export default router;
