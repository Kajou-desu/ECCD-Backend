import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { listUsers, registerUser, deleteUser } from "../controllers/users.controller.js";
import { auditAccountCreate, auditAccountDelete } from "../middleware/auditRoutes.js";

const router = Router();

router.use(requireAuth);
router.use(requireRole("Teacher", "Admin"));

router.get("/all", listUsers);
router.post("/register", auditAccountCreate, registerUser);
router.delete("/delete/:id", auditAccountDelete, deleteUser);

export default router;
