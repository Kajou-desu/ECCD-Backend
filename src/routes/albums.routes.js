import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getAlbums } from "../controllers/albums.controller.js";

const router = Router();

router.get("/", requireAuth, getAlbums);

export default router;
