import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/errorHandler.js";
import { parseId } from "../utils/validate.js";

const MAX_NAME_LENGTH = 100;

function requireCenterName(value) {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new AppError(`Enter the center's name (up to ${MAX_NAME_LENGTH} characters).`, 400);
  }
  return name;
}

// "ECCD Angeles" and "eccd angeles" are the same center.
async function nameTaken(name, exceptId) {
  const found = await prisma.center.findFirst({
    where: { name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return Boolean(found);
}

const duplicate = (name) => new AppError(`A center named "${name}" already exists.`, 409);

// GET /api/centers — Teacher/Admin. An Admin gets every center (for the
// account form's dropdown); a Teacher only their own, which is all they need.
export async function listCenters(req, res, next) {
  try {
    const where = req.user.role === "Admin" ? undefined : { id: req.user.centerId ?? -1 };
    const centers = await prisma.center.findMany({ where, select: { id: true, name: true }, orderBy: { name: "asc" } });
    res.json(centers);
  } catch (err) {
    next(err);
  }
}

// POST /api/centers — Admin only (enforced at route level).
export async function createCenter(req, res, next) {
  try {
    const name = requireCenterName(req.body.name);
    if (await nameTaken(name)) throw duplicate(name);
    const center = await prisma.center.create({ data: { name }, select: { id: true, name: true } });
    res.status(201).json(center);
  } catch (err) {
    if (err.code === "P2002") return next(duplicate(requireCenterName(req.body.name)));
    next(err);
  }
}

// PUT /api/centers/:id — Admin only. Renames; accounts follow by id.
export async function renameCenter(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    const name = requireCenterName(req.body.name);
    if (await nameTaken(name, id)) throw duplicate(name);
    const center = await prisma.center.update({ where: { id }, data: { name }, select: { id: true, name: true } });
    res.json(center);
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("Center not found.", 404));
    if (err.code === "P2002") return next(duplicate(requireCenterName(req.body.name)));
    next(err);
  }
}
