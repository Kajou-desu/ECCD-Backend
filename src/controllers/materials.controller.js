import { prisma } from "../lib/prisma.js";
import { fileUrl } from "../middleware/upload.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { parseId, requireNonEmptyString, optionalString } from "../utils/validate.js";

function toMaterialResponse(req, material) {
  return { ...material, fileUrl: signFileUrl(req, material.fileUrl) };
}

export async function getMaterials(req, res, next) {
  try {
    const materials = await prisma.material.findMany({ orderBy: { createdAt: "desc" } });
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
