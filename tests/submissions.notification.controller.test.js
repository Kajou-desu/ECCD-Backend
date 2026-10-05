import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    material: { findUnique: vi.fn() },
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
