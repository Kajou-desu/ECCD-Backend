import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { updateUser } from "../controllers/users.controller.js";

const router = Router();

// Account management's edit-account flow (AccountForm.jsx). Not a
// self-service "edit my own profile" endpoint — see users.controller.js
// for why only Teacher/Admin can reach it and what it enforces.
router.put("/update", requireAuth, requireRole("Teacher", "Admin"), updateUser);

export default router;
