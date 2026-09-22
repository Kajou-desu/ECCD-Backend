import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/errorHandler.js";
import { parseId } from "../utils/validate.js";
import { normalizeMac } from "../utils/macAddress.js";

// Teacher/admin only (enforced at route level).

export const MAX_DEVICES_PER_STUDENT = 5;

function toResponse(d) {
  return {
    id: d.id,
    studentId: d.studentId,
    deviceIdentifier: d.deviceIdentifier,
    enabled: d.enabled,
    registeredAt: d.registeredAt,
  };
}

async function assertStudentExists(studentId) {
  const student = await prisma.student.findUnique({ where: { id: studentId }, select: { id: true } });
  if (!student) throw new AppError("Student not found", 404);
}

export async function listBleDevices(req, res, next) {
  try {
    const studentId = parseId(req.params.id, "student id");
    await assertStudentExists(studentId);
    const devices = await prisma.studentBleDevice.findMany({
      where: { studentId },
      orderBy: { registeredAt: "asc" },
    });
    res.json(devices.map(toResponse));
  } catch (err) {
    next(err);
  }
}

export async function addBleDevice(req, res, next) {
  try {
    const studentId = parseId(req.params.id, "student id");
    const deviceIdentifier = normalizeMac(req.body?.deviceIdentifier);
    if (!deviceIdentifier) {
      throw new AppError("Invalid device identifier, expected a MAC like D7:40:47:15:14:90", 400);
    }
    await assertStudentExists(studentId);

    const existing = await prisma.studentBleDevice.count({ where: { studentId } });
    if (existing >= MAX_DEVICES_PER_STUDENT) {
      throw new AppError(`A student can have at most ${MAX_DEVICES_PER_STUDENT} devices`, 409);
    }

    try {
      const device = await prisma.studentBleDevice.create({ data: { studentId, deviceIdentifier } });
      res.status(201).json(toResponse(device));
    } catch (err) {
      // Unique violation. Deliberately does not say WHICH student owns the tag.
      if (err?.code === "P2002") throw new AppError("This device is already registered", 409);
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

// The where clause always includes studentId, so a device id belonging to a
// different student is simply "not found" — no cross-student access via the URL.
export async function setBleDeviceEnabled(req, res, next) {
  try {
    const studentId = parseId(req.params.id, "student id");
    const deviceId = parseId(req.params.deviceId, "device id");
    if (typeof req.body?.enabled !== "boolean") {
      throw new AppError("`enabled` must be true or false", 400);
    }

    const { count } = await prisma.studentBleDevice.updateMany({
      where: { id: deviceId, studentId },
      data: { enabled: req.body.enabled },
    });
    if (count === 0) throw new AppError("Device not found", 404);

    const device = await prisma.studentBleDevice.findUnique({ where: { id: deviceId } });
    res.json(toResponse(device));
  } catch (err) {
    next(err);
  }
}

export async function removeBleDevice(req, res, next) {
  try {
    const studentId = parseId(req.params.id, "student id");
    const deviceId = parseId(req.params.deviceId, "device id");
    const { count } = await prisma.studentBleDevice.deleteMany({ where: { id: deviceId, studentId } });
    if (count === 0) throw new AppError("Device not found", 404);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
