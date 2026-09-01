import { prisma } from "../lib/prisma.js";
import { fileUrl } from "../middleware/upload.js";

export async function getMaterials(_req, res, next) {
  try {
    const materials = await prisma.material.findMany({ orderBy: { createdAt: "desc" } });
    res.json(materials);
  } catch (err) {
    next(err);
  }
}

export async function createMaterial(req, res, next) {
  try {
    const { title, category, description } = req.body;
    if (!title) return res.status(400).json({ message: "Title required" });

    const material = await prisma.material.create({
      data: {
        title,
        category: category ?? null,
        description: description ?? null,
        fileUrl: req.file ? fileUrl(req, req.file.filename) : null,
      },
    });
    res.status(201).json(material);
  } catch (err) {
    next(err);
  }
}

export async function updateMaterial(req, res, next) {
  try {
    const { title, category, description } = req.body;
    const material = await prisma.material.update({
      where: { id: Number(req.params.id) },
      data: {
        ...(title !== undefined && { title }),
        ...(category !== undefined && { category }),
        ...(description !== undefined && { description }),
        ...(req.file && { fileUrl: fileUrl(req, req.file.filename) }),
      },
    });
    res.json(material);
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Material not found" });
    next(err);
  }
}

export async function deleteMaterial(req, res, next) {
  try {
    await prisma.material.delete({ where: { id: Number(req.params.id) } });
    res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Material not found" });
    next(err);
  }
}
