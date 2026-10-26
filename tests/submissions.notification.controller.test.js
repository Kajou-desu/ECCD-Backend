import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    material: { findUnique: vi.fn() },
    student: { findUnique: vi.fn() },
    submission: { create: vi.fn() },
  },
}));
vi.mock("../src/utils/ownership.js", () => ({ assertCanAccessStudent: vi.fn() }));
vi.mock("../src/middleware/upload.js", () => ({ fileUrl: () => "/uploads/f.png" }));
vi.mock("../src/lib/signedFileUrl.js", () => ({ signFileUrl: (_r, u) => u }));
vi.mock("../src/services/submissionNotification.service.js", () => ({
  notifyTeacherOfSubmission: vi.fn().mockResolvedValue(undefined),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { notifyTeacherOfSubmission } = await import(
  "../src/services/submissionNotification.service.js"
);
const { submitStudentWork } = await import("../src/controllers/submissions.controller.js");

function run(role) {
  const req = {
    user: { id: 1, role },
    body: { materialId: "3", studentId: "5" },
    file: { filename: "f.png", originalname: "f.png" },
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  return submitStudentWork(req, res, vi.fn()).then(() => res);
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.student.findUnique.mockResolvedValue({ teacher: { centerId: 4 } });
  prisma.material.findUnique.mockResolvedValue({ id: 3, title: "Shapes" });
  prisma.submission.create.mockResolvedValue({ id: 9, fileUrl: "/uploads/f.png" });
});

describe("submitStudentWork notifications", () => {
  it.each(["Parent", "Guardian"])("notifies the teacher when a %s submits", async (role) => {
    const res = await run(role);
    await new Promise((r) => setImmediate(r));
    expect(res.status).toHaveBeenCalledWith(201);
    expect(notifyTeacherOfSubmission).toHaveBeenCalledWith(5, "Shapes");
  });

  it.each(["Teacher", "Admin"])("does not notify when a %s submits", async (role) => {
    await run(role);
    await new Promise((r) => setImmediate(r));
    expect(notifyTeacherOfSubmission).not.toHaveBeenCalled();
  });
});

describe("submitStudentWork and centers", () => {
  it("only accepts work for a material of the student's own center", async () => {
    const res = await run("Parent");

    expect(prisma.material.findUnique).toHaveBeenCalledWith({ where: { id: 3, centerId: 4 } });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("answers 404, and saves nothing, for another center's material", async () => {
    prisma.material.findUnique.mockResolvedValue(null);

    const res = await run("Parent");
    await new Promise((r) => setImmediate(r));

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: "Material not found" });
    expect(prisma.submission.create).not.toHaveBeenCalled();
    expect(notifyTeacherOfSubmission).not.toHaveBeenCalled();
  });

  it.each([
    ["has no Teacher", { teacher: null }],
    ["has a Teacher with no center", { teacher: { centerId: null } }],
    ["does not exist", null],
  ])("answers 404 without looking for a material when the student %s", async (_name, student) => {
    prisma.student.findUnique.mockResolvedValue(student);

    const res = await run("Teacher");

    expect(res.status).toHaveBeenCalledWith(404);
    expect(prisma.material.findUnique).not.toHaveBeenCalled();
    expect(prisma.submission.create).not.toHaveBeenCalled();
  });
});
