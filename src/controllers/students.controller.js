import { prisma } from "../lib/prisma.js";
import { assertCanAccessStudent } from "../utils/ownership.js";
import { parseId, requireNonEmptyString } from "../utils/validate.js";

// Teacher/admin only (enforced at route level) — full roster.
export async function getStudents(req, res, next) {
  try {
    const { classroom, search } = req.query;
    const students = await prisma.student.findMany({
      where: {
        ...(classroom && { classroom: String(classroom).slice(0, 100) }),
        ...(search && { name: { contains: String(search).slice(0, 100), mode: "insensitive" } }),
      },
      orderBy: { name: "asc" },
    });
    res.json(students);
  } catch (err) {
    next(err);
  }
}

// Any authenticated role; PARENT restricted to their own linked children.
export async function getStudent(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    await assertCanAccessStudent(req.user, id);

    const student = await prisma.student.findUnique({ where: { id } });
    if (!student) return res.status(404).json({ message: "Student not found" });
    res.json(student);
  } catch (err) {
    next(err);
  }
}

// Teacher/admin only (enforced at route level).
export async function createStudent(req, res, next) {
  try {
    const name = requireNonEmptyString(req.body.name, "name", 200);
    const { birthdate, classroom } = req.body;

    let birthdateValue = null;
    if (birthdate !== undefined && birthdate !== null && birthdate !== "") {
      const parsed = new Date(birthdate);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ message: "Invalid birthdate" });
      }
      birthdateValue = parsed;
    }

    const student = await prisma.student.create({
      data: {
        name,
        classroom: classroom ? String(classroom).slice(0, 100) : null,
        birthdate: birthdateValue,
      },
    });
    res.status(201).json(student);
  } catch (err) {
    next(err);
  }
}

// Teacher/admin only (enforced at route level).
export async function updateStudent(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    const { name, birthdate, classroom } = req.body;

    let birthdateValue;
    if (birthdate !== undefined) {
      if (birthdate === null || birthdate === "") {
        birthdateValue = null;
      } else {
        const parsed = new Date(birthdate);
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({ message: "Invalid birthdate" });
        }
        birthdateValue = parsed;
      }
    }

    const student = await prisma.student.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: requireNonEmptyString(name, "name", 200) }),
        ...(classroom !== undefined && { classroom: classroom ? String(classroom).slice(0, 100) : null }),
        ...(birthdateValue !== undefined && { birthdate: birthdateValue }),
      },
    });
    res.json(student);
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Student not found" });
    next(err);
  }
}

// Teacher/admin only (enforced at route level).
export async function deleteStudent(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    await prisma.student.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Student not found" });
    next(err);
  }
}
