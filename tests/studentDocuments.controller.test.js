import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    studentDocument: { deleteMany: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { deleteStudentDocument } = await import(
  "../src/controllers/studentDocuments.controller.js"
);

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deleteStudentDocument", () => {
  it("scopes deletion to both studentId and documentId", async () => {
    prisma.studentDocument.deleteMany.mockResolvedValue({ count: 1 });

    const req = { params: { id: "10", documentId: "42" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteStudentDocument(req, res, next);

    expect(prisma.studentDocument.deleteMany).toHaveBeenCalledWith({
      where: { id: 42, studentId: 10 },
    });
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("404s when the document doesn't belong to that student", async () => {
    prisma.studentDocument.deleteMany.mockResolvedValue({ count: 0 });

    const req = { params: { id: "10", documentId: "999" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteStudentDocument(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
