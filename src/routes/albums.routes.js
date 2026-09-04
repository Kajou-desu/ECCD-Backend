import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import {
  getAlbums,
  createAlbum,
  deleteAlbum,
  addAlbumPhotos,
  deleteAlbumPhoto,
} from "../controllers/albums.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/", getAlbums); // teacher + parent views share this list
router.post("/", requireRole("Teacher", "Admin"), createAlbum);
router.delete("/:albumId", requireRole("Teacher", "Admin"), deleteAlbum);
router.post(
  "/:albumId/photos",
  requireRole("Teacher", "Admin"),
  upload.array("photos", 20),
  addAlbumPhotos
);
router.delete("/:albumId/photos/:photoId", requireRole("Teacher", "Admin"), deleteAlbumPhoto);

export default router;
