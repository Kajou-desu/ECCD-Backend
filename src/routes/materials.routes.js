import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import {
  getMaterials,
  createMaterial,
  updateMaterial,
  deleteMaterial,
} from "../controllers/materials.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/", getMaterials);
router.post("/", requireRole("Teacher", "Admin"), upload.single("file"), createMaterial);
router.put("/:id", requireRole("Teacher", "Admin"), upload.single("file"), updateMaterial);
router.delete("/:id", requireRole("Teacher", "Admin"), deleteMaterial);

export default router;
