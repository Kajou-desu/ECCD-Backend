import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    material: { findUnique: vi.fn() },
    student: { findUnique: vi.fn() },
    submission: { create: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../src/lib/fileStorage.js", () => ({
  removeStoredFiles: vi.fn().mockResolvedValue(undefined),
  removeUploadedFiles: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/utils/ownership.js", () => ({ assertCanAccessStudent: vi.fn() }));
vi.mock("../src/middleware/upload.js", () => ({ fileUrl: () => "/uploads/new.png" }));
vi.mock("../src/lib/signedFileUrl.js", () => ({ signFileUrl: (_r, u) => u }));
vi.mock("../src/services/submissionNotification.service.js", () => ({
  notifyTeacherOfSubmission: vi.fn().mockResolvedValue(undefined),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { removeStoredFiles, removeUploadedFiles } = await import("../src/lib/fileStorage.js");
const { submitStudentWork } = await import("../src/controllers/submissions.controller.js");

function run(extraBody = {}) {
  const req = {
    user: { id: 1, role: "Teacher" },
    body: { materialId: "3", studentId: "5", ...extraBody },
    file: { filename: "new.png", originalname: "new.png" },
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  return submitStudentWork(req, res, vi.fn()).then(() => ({ req, res }));
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.student.findUnique.mockResolvedValue({ teacher: { centerId: 4 } });
  prisma.material.findUnique.mockResolvedValue({ id: 3, title: "Shapes" });
  prisma.submission.create.mockResolvedValue({ id: 9, fileUrl: "/uploads/new.png" });
  prisma.submission.deleteMany.mockResolvedValue({ count: 1 });
  prisma.$transaction.mockImplementation(async (ops) => Promise.all(ops));
});

describe("submitStudentWork when the student already uploaded for the material", () => {
  it("uploads normally when there is no earlier work", async () => {
    prisma.submission.findMany.mockResolvedValue([]);
    const { res } = await run();
    expect(prisma.submission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { materialId: 3, studentId: 5 } }),
    );
    expect(prisma.submission.create).toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("answers 409 and discards the new file when work exists and replace was not asked for", async () => {
    prisma.submission.findMany.mockResolvedValue([{ id: 1, fileUrl: "/uploads/old.png" }]);
    const { req, res } = await run();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "SUBMISSION_EXISTS" }));
    expect(removeUploadedFiles).toHaveBeenCalledWith(req);
    expect(prisma.submission.create).not.toHaveBeenCalled();
    expect(prisma.submission.deleteMany).not.toHaveBeenCalled();
    expect(removeStoredFiles).not.toHaveBeenCalled();
  });

  it.each(["false", "1", "yes", ""])("treats replace=%j as not confirmed", async (replace) => {
    prisma.submission.findMany.mockResolvedValue([{ id: 1, fileUrl: "/uploads/old.png" }]);
    const { res } = await run({ replace });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(prisma.submission.create).not.toHaveBeenCalled();
  });

  it("with replace=true swaps the old work for the new in one transaction and removes the old file", async () => {
    prisma.submission.findMany.mockResolvedValue([
      { id: 1, fileUrl: "/uploads/old.png" },
      { id: 2, fileUrl: "/uploads/older.png" },
    ]);
    const { res } = await run({ replace: "true" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.submission.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1, 2] } } });
    expect(prisma.submission.create).toHaveBeenCalled();
    expect(removeStoredFiles).toHaveBeenCalledWith(["/uploads/old.png", "/uploads/older.png"]);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("replace=true with no earlier work is a plain upload", async () => {
    prisma.submission.findMany.mockResolvedValue([]);
    const { res } = await run({ replace: "true" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
