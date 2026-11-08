import { prisma } from "../lib/prisma.js";
import { fileUrl } from "../middleware/upload.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { parseId, parsePagination, requireNonEmptyString, optionalString } from "../utils/validate.js";
import { removeStoredFiles } from "../lib/fileStorage.js";
import {
  contentScopeFor,
  staffContentScopeFor,
  centerForNewContent,
  isMissingCenter,
} from "../utils/contentScope.js";

function toMaterialResponse(req, material) {
  return { ...material, fileUrl: signFileUrl(req, material.fileUrl) };
}

// Materials belong to a center (see utils/contentScope.js): a Teacher or a
// Parent/Guardian gets their own center's, an Admin every center's.
// ?page & ?pageSize are optional; omitting both returns every material
// exactly as before (see parsePagination). Total count sent via
// X-Total-Count when paginated, so the response body shape never changes.
export async function getMaterials(req, res, next) {
  try {
    const pagination = parsePagination(req.query);
    // No scope = no center yet: an empty list, never another center's materials.
    const scope = contentScopeFor(req.user);
    if (!scope) {
      if (pagination) res.set("X-Total-Count", "0");
      return res.json([]);
    }

    const [materials, total] = await Promise.all([
      prisma.material.findMany({
        where: scope,
        orderBy: { createdAt: "desc" },
        ...(pagination && { skip: pagination.skip, take: pagination.take }),
      }),
      pagination ? prisma.material.count({ where: scope }) : Promise.resolve(null),
    ]);

    if (pagination) res.set("X-Total-Count", String(total));
    res.json(materials.map((m) => toMaterialResponse(req, m)));
  } catch (err) {
    next(err);
  }
}

export async function createMaterial(req, res, next) {
  try {
    // A Teacher's own center; an Admin must name one. Never taken from a Teacher's body.
    const centerId = centerForNewContent(req);
    const title = requireNonEmptyString(req.body.title, "title", 200);
    const category = optionalString(req.body.category, 100);
    const description = optionalString(req.body.description, 2000);

    const material = await prisma.material.create({
      data: {
        title,
        category,
        description,
        centerId,
        fileUrl: req.file ? fileUrl(req, req.file.filename) : null,
      },
    });
    res.status(201).json(toMaterialResponse(req, material));
  } catch (err) {
    if (isMissingCenter(err)) return res.status(400).json({ message: "Center not found" });
    next(err);
  }
}

// A material can only be changed by Teachers of its center (or an Admin). One
// outside that scope is "not found", the same as a missing one, so its id says
// nothing about other centers. Its center is never changed here.
export async function updateMaterial(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    const scope = staffContentScopeFor(req.user);
    const { title, category, description } = req.body;

    // Only needed when a replacement file arrives: the old one becomes an orphan.
    const previous = req.file
      ? await prisma.material.findUnique({ where: { id, ...scope }, select: { fileUrl: true } })
      : null;

    const material = await prisma.material.update({
      where: { id, ...scope },
      data: {
        ...(title !== undefined && { title: requireNonEmptyString(title, "title", 200) }),
        ...(category !== undefined && { category: optionalString(category, 100) }),
        ...(description !== undefined && { description: optionalString(description, 2000) }),
        ...(req.file && { fileUrl: fileUrl(req, req.file.filename) }),
      },
    });
    if (previous?.fileUrl) await removeStoredFiles(previous.fileUrl);
    res.json(toMaterialResponse(req, material));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Material not found" });
    next(err);
  }
}

export async function deleteMaterial(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    const scope = staffContentScopeFor(req.user);

    // Deleting a material cascades to the students' submitted work; collect
    // those files first so nothing is left on disk once the rows are gone.
    // Nothing is removed unless the delete below succeeds, which it only does
    // for a material inside the caller's scope.
    const submissions = await prisma.submission.findMany({
      where: { materialId: id },
      select: { fileUrl: true },
    });

    const deleted = await prisma.material.delete({ where: { id, ...scope } });
    await removeStoredFiles(deleted.fileUrl, submissions.map((s) => s.fileUrl));
    res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Material not found" });
    next(err);
  }
}
