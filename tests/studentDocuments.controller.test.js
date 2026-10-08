import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    studentDocument: { findFirst: vi.fn(), deleteMany: vi.fn() },
    student: { findUnique: vi.fn() },
    parentChild: { findUnique: vi.fn() },
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
const { deleteStudentDocument, getStudentDocumentLink } = await import(
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

    const req = { params: { id: "10", documentId: "42" }, user: { id: 1, role: "Admin" } };
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

    await deleteStudentDocument(
      { params: { id: "10", documentId: "42" }, user: { id: 1, role: "Admin" } },
      mockRes(),
      vi.fn(),
    );

    expect(removeStoredFiles).toHaveBeenCalledWith("http://h/api/files/a.pdf");
  });

  it("404s when the document doesn't belong to that student", async () => {
    prisma.studentDocument.findFirst.mockResolvedValue(null);

    const req = { params: { id: "10", documentId: "999" }, user: { id: 1, role: "Admin" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteStudentDocument(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(prisma.studentDocument.deleteMany).not.toHaveBeenCalled();
    expect(removeStoredFiles).not.toHaveBeenCalled(); // never touch files for a row we didn't delete
  });
});

describe("getStudentDocumentLink", () => {
  const OLD_SECRET = process.env.JWT_SECRET;
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  });
  afterAll(() => {
    process.env.JWT_SECRET = OLD_SECRET;
  });

  const reqFor = (user, params = { id: "10", documentId: "42" }) => ({
    params,
    user,
    protocol: "https",
    get: () => "api.example.com",
  });

  it("returns a fresh, short-lived, no-store link scoped to studentId and documentId", async () => {
    prisma.studentDocument.findFirst.mockResolvedValue({ fileUrl: "a.pdf" });
    const res = mockRes();
    res.set = vi.fn();

    await getStudentDocumentLink(reqFor({ id: 1, role: "Admin" }), res, vi.fn());

    expect(prisma.studentDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 42, studentId: 10 } }),
    );
    const { url } = res.json.mock.calls[0][0];
    expect(url).toMatch(/^https:\/\/api\.example\.com\/api\/files\/a\.pdf\?exp=\d+&sig=[0-9a-f]+&s=1$/);
    expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");
  });

  it("answers 404 for a document that belongs to a different student", async () => {
    prisma.studentDocument.findFirst.mockResolvedValue(null);
    const res = mockRes();
    res.set = vi.fn();

    await getStudentDocumentLink(reqFor({ id: 1, role: "Admin" }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("refuses a Teacher who isn't assigned to the student, before touching the document", async () => {
    prisma.student.findUnique.mockResolvedValue({ teacherId: 99 });
    const next = vi.fn();

    await getStudentDocumentLink(reqFor({ id: 1, role: "Teacher" }), mockRes(), next);

    expect(next.mock.calls[0][0].status).toBe(403);
    expect(prisma.studentDocument.findFirst).not.toHaveBeenCalled();
  });

  it("lets a linked Parent get the link", async () => {
    prisma.parentChild.findUnique.mockResolvedValue({ parentId: 5, studentId: 10 });
    prisma.studentDocument.findFirst.mockResolvedValue({ fileUrl: "a.pdf" });
    const res = mockRes();
    res.set = vi.fn();

    await getStudentDocumentLink(reqFor({ id: 5, role: "Parent" }), res, vi.fn());

    expect(res.json).toHaveBeenCalled();
  });

  it("refuses a Parent with no link to that student", async () => {
    prisma.parentChild.findUnique.mockResolvedValue(null);
    const next = vi.fn();

    await getStudentDocumentLink(reqFor({ id: 5, role: "Parent" }), mockRes(), next);

    expect(next.mock.calls[0][0].status).toBe(403);
  });
});
