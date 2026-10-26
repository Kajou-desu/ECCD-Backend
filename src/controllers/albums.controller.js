import { prisma } from "../lib/prisma.js";
import { fileUrl } from "../middleware/upload.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { parseId, parsePagination, requireNonEmptyString, optionalString } from "../utils/validate.js";
import { removeStoredFiles } from "../lib/fileStorage.js";
import { AppError } from "../middleware/errorHandler.js";
import {
  contentScopeFor,
  staffContentScopeFor,
  centerForNewContent,
  isMissingCenter,
} from "../utils/contentScope.js";

// Frontend reads photo.url (not fileUrl) everywhere it renders a photo
// (PhotoThumbnail, PhotoPreviewModal, AlbumCard cover image), so every
// photo object returned from this controller is shaped { id, url, caption }.
function toPhotoResponse(req, photo) {
  return { id: photo.id, url: signFileUrl(req, photo.fileUrl), caption: photo.caption };
}

// Multer's originalname is client-controlled and uncapped: normalize, drop
// control characters (incl. newlines/NUL) and cap at the 255-char filename norm.
const CAPTION_MAX = 255;
function toCaption(originalname) {
  return String(originalname ?? "")
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, CAPTION_MAX);
}

function toAlbumResponse(req, album) {
  return {
    id: album.id,
    title: album.title,
    association: album.event
      ? { type: "event", id: album.event.id, title: album.event.title }
      : album.activity
        ? { type: "activity", id: album.activity.id, title: album.activity.title }
        : null,
    associationName: album.event?.title ?? album.activity?.title ?? null,
    description: album.description,
    createdAt: album.createdAt,
    photos: (album.photos || []).map((photo) => toPhotoResponse(req, photo)),
  };
}

// Teacher + parent views share this list, scoped to the caller's CENTER (see
// utils/contentScope.js): a Teacher or Parent/Guardian gets their own center's
// albums, an Admin every center's, and anyone with no center nothing.
// Deliberately NOT scoped to a parent's own children — Album/Photo have no
// student linkage at all (confirmed intentional in the 2026-09 QA review,
// finding #2). Within a center this is a shared classroom gallery by design:
// every parent at that center sees every album/photo, same as a physical
// bulletin board in the classroom would. Do not "fix" this into per-child
// scoping without a deliberate product decision to change that behavior — it
// would need a new student-linkage table and migration, not a small patch.
// ?page & ?pageSize paginate the album list itself (not photos within an
// album); omitting both returns every album exactly as before (see
// parsePagination). Total album count sent via X-Total-Count when paginated.
export async function getAlbums(req, res, next) {
  try {
    const pagination = parsePagination(req.query);

    // No scope = no center yet: an empty list, never another center's albums.
    const scope = contentScopeFor(req.user);
    if (!scope) {
      if (pagination) res.set("X-Total-Count", "0");
      return res.json([]);
    }

    const [albums, total] = await Promise.all([
      prisma.album.findMany({
        where: scope,
        include: {
          photos: true,
          event: { select: { id: true, title: true } },
          activity: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: "desc" },
        ...(pagination && { skip: pagination.skip, take: pagination.take }),
      }),
      pagination ? prisma.album.count({ where: scope }) : Promise.resolve(null),
    ]);

    if (pagination) res.set("X-Total-Count", String(total));
    res.json(albums.map((album) => toAlbumResponse(req, album)));
  } catch (err) {
    next(err);
  }
}

// Teacher/admin only (enforced at route level).
export async function createAlbum(req, res, next) {
  try {
    // A Teacher's own center; an Admin must name one. Never taken from a Teacher's body.
    const centerId = centerForNewContent(req);
    const title = requireNonEmptyString(req.body.title, "title", 200);
    const description = optionalString(req.body.description, 1000);
    const { associationType } = req.body;
    const associationId = parseId(req.body.associationId, "associationId");
    if (associationType !== "event" && associationType !== "activity") {
      throw new AppError("Choose an event or activity for this album.");
    }

    // Events are school-wide, but an activity must belong to the album's own center.
    const target = associationType === "event"
      ? await prisma.event.findUnique({ where: { id: associationId }, select: { id: true } })
      : await prisma.material.findUnique({ where: { id: associationId, centerId }, select: { id: true } });
    if (!target) throw new AppError(`Selected ${associationType} was not found.`, 404);

    const album = await prisma.album.create({
      data: {
        title,
        description,
        centerId,
        eventId: associationType === "event" ? associationId : null,
        materialId: associationType === "activity" ? associationId : null,
      },
      include: {
        photos: true,
        event: { select: { id: true, title: true } },
        activity: { select: { id: true, title: true } },
      },
    });
    res.status(201).json(toAlbumResponse(req, album));
  } catch (err) {
    if (isMissingCenter(err)) return res.status(400).json({ message: "Center not found" });
    next(err);
  }
}

// An album can only be changed by Teachers of its center (or an Admin). One
// outside that scope is "not found", the same as a missing one, so its id says
// nothing about other centers. Its center is never changed here.
export async function updateAlbum(req, res, next) {
  try {
    const id = parseId(req.params.albumId, "albumId");
    const scope = staffContentScopeFor(req.user);
    const title = requireNonEmptyString(req.body.title, "title", 200);
    const data = { title };
    if (req.body.description !== undefined) data.description = optionalString(req.body.description, 1000);

    if (req.body.associationType !== undefined || req.body.associationId !== undefined) {
      const { associationType } = req.body;
      const associationId = parseId(req.body.associationId, "associationId");
      if (associationType !== "event" && associationType !== "activity") {
        throw new AppError("Choose an event or activity for this album.");
      }

      // The activity must belong to the album's own center (an Admin has none of
      // their own, so it is read from the album).
      const existing = await prisma.album.findUnique({ where: { id, ...scope }, select: { centerId: true } });
      if (!existing) throw new AppError("Album not found", 404);

      const target = associationType === "event"
        ? await prisma.event.findUnique({ where: { id: associationId }, select: { id: true } })
        : await prisma.material.findUnique({
            where: { id: associationId, centerId: existing.centerId },
            select: { id: true },
          });
      if (!target) throw new AppError(`Selected ${associationType} was not found.`, 404);

      data.eventId = associationType === "event" ? associationId : null;
      data.materialId = associationType === "activity" ? associationId : null;
    }

    const album = await prisma.album.update({
      where: { id, ...scope },
      data,
      include: {
        photos: true,
        event: { select: { id: true, title: true } },
        activity: { select: { id: true, title: true } },
      },
    });
    res.json(toAlbumResponse(req, album));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Album not found" });
    next(err);
  }
}

// Teacher/admin only (enforced at route level).
export async function deleteAlbum(req, res, next) {
  try {
    const id = parseId(req.params.albumId, "albumId");
    const scope = staffContentScopeFor(req.user);

    // Nothing is removed unless the delete below succeeds, which it only does
    // for an album inside the caller's scope.
    const photos = await prisma.photo.findMany({ where: { albumId: id }, select: { fileUrl: true } });
    await prisma.album.delete({ where: { id, ...scope } }); // cascades to photos
    await removeStoredFiles(photos.map((p) => p.fileUrl));
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
    const scope = staffContentScopeFor(req.user);
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ message: "At least one photo required" });
    }

    // Photos can only go into an album of the caller's own center (an Admin: any).
    // The upload middleware discards the files again on this 404.
    const album = await prisma.album.findUnique({ where: { id: albumId, ...scope } });
    if (!album) return res.status(404).json({ message: "Album not found" });

    // Created in upload order — the frontend merges the response back into
    // its optimistic photo list by matching array index.
    const created = await prisma.$transaction(
      files.map((file) =>
        prisma.photo.create({
          data: {
            albumId,
            fileUrl: fileUrl(req, file.filename),
            caption: toCaption(file.originalname),
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
    const scope = staffContentScopeFor(req.user);

    // The photo must be in THIS album, and the album in the caller's scope.
    const photo = await prisma.photo.findFirst({ where: { id: photoId, albumId, album: scope } });
    if (!photo) {
      return res.status(404).json({ message: "Photo not found" });
    }

    await prisma.photo.delete({ where: { id: photoId } });
    await removeStoredFiles(photo.fileUrl);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
