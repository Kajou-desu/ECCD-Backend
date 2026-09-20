import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    studentDocument: { findFirst: vi.fn(), deleteMany: vi.fn() },
  },
}));

// Partial mock: keep the real exports (upload.js imports UPLOAD_DIR) and
// replace only the delete, so no test ever touches the filesystem.
const { removeStoredFiles } = vi.hoisted(() => ({ removeStoredFiles: vi.fn() }));
vi.mock("../src/lib/fileStorage.js", async (importOriginal) => ({
  ...(await importOriginal()),
  removeStoredFiles,
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
    prisma.studentDocument.findFirst.mockResolvedValue({ fileUrl: "http://h/api/files/a.pdf" });
    prisma.studentDocument.deleteMany.mockResolvedValue({ count: 1 });

    const req = { params: { id: "10", documentId: "42" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteStudentDocument(req, res, next);

    expect(prisma.studentDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 42, studentId: 10 } })
    );
    expect(prisma.studentDocument.deleteMany).toHaveBeenCalledWith({
      where: { id: 42, studentId: 10 },
    });
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("deletes the stored file along with the row", async () => {
    prisma.studentDocument.findFirst.mockResolvedValue({ fileUrl: "http://h/api/files/a.pdf" });
    prisma.studentDocument.deleteMany.mockResolvedValue({ count: 1 });

    await deleteStudentDocument({ params: { id: "10", documentId: "42" } }, mockRes(), vi.fn());

    expect(removeStoredFiles).toHaveBeenCalledWith("http://h/api/files/a.pdf");
  });

  it("404s when the document doesn't belong to that student", async () => {
    prisma.studentDocument.findFirst.mockResolvedValue(null);

    const req = { params: { id: "10", documentId: "999" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteStudentDocument(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(prisma.studentDocument.deleteMany).not.toHaveBeenCalled();
    expect(removeStoredFiles).not.toHaveBeenCalled(); // never touch files for a row we didn't delete
  });
});
