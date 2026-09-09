import { prisma } from "../lib/prisma.js";
import { fileUrl } from "../middleware/upload.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { parseId, parsePagination, requireNonEmptyString, optionalString } from "../utils/validate.js";

function toMaterialResponse(req, material) {
  return { ...material, fileUrl: signFileUrl(req, material.fileUrl) };
}

// ?page & ?pageSize are optional; omitting both returns every material
// exactly as before (see parsePagination). Total count sent via
// X-Total-Count when paginated, so the response body shape never changes.
export async function getMaterials(req, res, next) {
  try {
    const pagination = parsePagination(req.query);

    const [materials, total] = await Promise.all([
      prisma.material.findMany({
        orderBy: { createdAt: "desc" },
        ...(pagination && { skip: pagination.skip, take: pagination.take }),
      }),
      pagination ? prisma.material.count() : Promise.resolve(null),
    ]);

    if (pagination) res.set("X-Total-Count", String(total));
    res.json(materials.map((m) => toMaterialResponse(req, m)));
  } catch (err) {
    next(err);
  }
}

export async function createMaterial(req, res, next) {
  try {
    const title = requireNonEmptyString(req.body.title, "title", 200);
    const category = optionalString(req.body.category, 100);
    const description = optionalString(req.body.description, 2000);

    const material = await prisma.material.create({
      data: {
        title,
        category,
        description,
        fileUrl: req.file ? fileUrl(req, req.file.filename) : null,
      },
    });
    res.status(201).json(toMaterialResponse(req, material));
  } catch (err) {
    next(err);
  }
}

export async function updateMaterial(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    const { title, category, description } = req.body;

    const material = await prisma.material.update({
      where: { id },
      data: {
        ...(title !== undefined && { title: requireNonEmptyString(title, "title", 200) }),
        ...(category !== undefined && { category: optionalString(category, 100) }),
        ...(description !== undefined && { description: optionalString(description, 2000) }),
        ...(req.file && { fileUrl: fileUrl(req, req.file.filename) }),
      },
    });
    res.json(toMaterialResponse(req, material));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Material not found" });
    next(err);
  }
}

export async function deleteMaterial(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    await prisma.material.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Material not found" });
    next(err);
  }
}
