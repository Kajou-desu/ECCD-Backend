import { prisma } from "../lib/prisma.js";
import { fileUrl } from "../middleware/upload.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { parseId, requireNonEmptyString } from "../utils/validate.js";

// Frontend reads photo.url (not fileUrl) everywhere it renders a photo
// (PhotoThumbnail, PhotoPreviewModal, AlbumCard cover image), so every
// photo object returned from this controller is shaped { id, url, caption }.
function toPhotoResponse(req, photo) {
  return { id: photo.id, url: signFileUrl(req, photo.fileUrl), caption: photo.caption };
}

function toAlbumResponse(req, album) {
  return {
    id: album.id,
    title: album.title,
    category: album.category,
    description: album.description,
    createdAt: album.createdAt,
    photos: (album.photos || []).map((photo) => toPhotoResponse(req, photo)),
  };
}

// Any authenticated role (teacher + parent views share this list).
export async function getAlbums(req, res, next) {
  try {
    const albums = await prisma.album.findMany({
      include: { photos: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(albums.map((album) => toAlbumResponse(req, album)));
  } catch (err) {
    next(err);
  }
}

// Teacher/admin only (enforced at route level).
export async function createAlbum(req, res, next) {
  try {
    const title = requireNonEmptyString(req.body.title, "title", 200);
    const album = await prisma.album.create({
      data: { title },
      include: { photos: true },
    });
    res.status(201).json(toAlbumResponse(req, album));
  } catch (err) {
    next(err);
  }
}

// Teacher/admin only (enforced at route level).
export async function deleteAlbum(req, res, next) {
  try {
    const id = parseId(req.params.albumId, "albumId");
    await prisma.album.delete({ where: { id } }); // cascades to photos
    res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Album not found" });
    next(err);
  }
}

// POST /api/albums/:albumId/photos (multipart, field "photos", multiple)
// Teacher/admin only (enforced at route level).
export async function addAlbumPhotos(req, res, next) {
  try {
    const albumId = parseId(req.params.albumId, "albumId");
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ message: "At least one photo required" });
    }

    const album = await prisma.album.findUnique({ where: { id: albumId } });
    if (!album) return res.status(404).json({ message: "Album not found" });

    // Created in upload order — the frontend merges the response back into
    // its optimistic photo list by matching array index.
    const created = await prisma.$transaction(
      files.map((file) =>
        prisma.photo.create({
          data: {
            albumId,
            fileUrl: fileUrl(req, file.filename),
            caption: file.originalname,
          },
        })
      )
    );

    res.status(201).json(created.map((photo) => toPhotoResponse(req, photo)));
  } catch (err) {
    next(err);
  }
}

// Teacher/admin only (enforced at route level).
export async function deleteAlbumPhoto(req, res, next) {
  try {
    const albumId = parseId(req.params.albumId, "albumId");
    const photoId = parseId(req.params.photoId, "photoId");

    const photo = await prisma.photo.findUnique({ where: { id: photoId } });
    if (!photo || photo.albumId !== albumId) {
      return res.status(404).json({ message: "Photo not found" });
    }

    await prisma.photo.delete({ where: { id: photoId } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
