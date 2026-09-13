import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { listUsers, registerUser, deleteUser } from "../controllers/users.controller.js";

const router = Router();

router.use(requireAuth);
router.use(requireRole("Teacher", "Admin"));

router.get("/all", listUsers);
router.post("/register", registerUser);
router.delete("/delete/:id", deleteUser);

export default router;
