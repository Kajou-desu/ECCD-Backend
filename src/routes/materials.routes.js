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
router.post("/", requireRole("TEACHER", "ADMIN"), upload.single("file"), createMaterial);
router.put("/:id", requireRole("TEACHER", "ADMIN"), upload.single("file"), updateMaterial);
router.delete("/:id", requireRole("TEACHER", "ADMIN"), deleteMaterial);

export default router;
