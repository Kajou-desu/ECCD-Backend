import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    material: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    submission: { findMany: vi.fn() },
    album: { delete: vi.fn() },
    photo: { findMany: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    student: { delete: vi.fn() },
    studentDocument: { findMany: vi.fn() },
  },
}));

// Partial mock: real exports stay (upload.js needs UPLOAD_DIR); only deletion is faked.
const { removeStoredFiles } = vi.hoisted(() => ({ removeStoredFiles: vi.fn() }));
vi.mock("../src/lib/fileStorage.js", async (importOriginal) => ({
  ...(await importOriginal()),
  removeStoredFiles,
}));

const { recognition } = vi.hoisted(() => ({
  recognition: { isRecognitionConfigured: vi.fn(() => true), removeStudentEnrollment: vi.fn() },
}));
vi.mock("../src/services/recognitionClient.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ...recognition,
}));

const { prisma } = await import("../src/lib/prisma.js");
const { deleteMaterial, updateMaterial } = await import("../src/controllers/materials.controller.js");
const { deleteAlbum, deleteAlbumPhoto } = await import("../src/controllers/albums.controller.js");
const { deleteStudent } = await import("../src/controllers/students.controller.js");

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
}
const req = (extra = {}) => ({ params: {}, body: {}, protocol: "https", get: () => "host", ...extra });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("files are removed together with their database rows", () => {
  it("deleteMaterial removes the material's file AND every student submission for it", async () => {
    prisma.submission.findMany.mockResolvedValue([{ fileUrl: "s1.pdf" }, { fileUrl: "s2.png" }]);
    prisma.material.delete.mockResolvedValue({ id: 5, fileUrl: "m.pdf" });

    await deleteMaterial(req({ params: { id: "5" } }), mockRes(), vi.fn());

    expect(prisma.submission.findMany).toHaveBeenCalledWith({
      where: { materialId: 5 },
      select: { fileUrl: true },
    });
    expect(removeStoredFiles).toHaveBeenCalledWith("m.pdf", ["s1.pdf", "s2.png"]);
  });

  it("deleteMaterial removes nothing when the material doesn't exist", async () => {
    prisma.submission.findMany.mockResolvedValue([]);
    prisma.material.delete.mockRejectedValue(Object.assign(new Error("gone"), { code: "P2025" }));

    const res = mockRes();
    await deleteMaterial(req({ params: { id: "5" } }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(removeStoredFiles).not.toHaveBeenCalled();
  });

  it("updateMaterial removes the replaced file, but only when a new one was uploaded", async () => {
    prisma.material.findUnique.mockResolvedValue({ fileUrl: "old.pdf" });
    prisma.material.update.mockResolvedValue({ id: 5, fileUrl: "new.pdf" });

    await updateMaterial(
      req({ params: { id: "5" }, body: { title: "T" }, file: { filename: "new.pdf" } }),
      mockRes(),
      vi.fn()
    );
    expect(removeStoredFiles).toHaveBeenCalledWith("old.pdf");

    removeStoredFiles.mockClear();
    prisma.material.findUnique.mockClear();
    await updateMaterial(req({ params: { id: "5" }, body: { title: "T2" } }), mockRes(), vi.fn());
    expect(removeStoredFiles).not.toHaveBeenCalled();
    expect(prisma.material.findUnique).not.toHaveBeenCalled();
  });

  it("deleteAlbum removes every photo file in the album", async () => {
    prisma.photo.findMany.mockResolvedValue([{ fileUrl: "p1.jpg" }, { fileUrl: "p2.jpg" }]);
    prisma.album.delete.mockResolvedValue({ id: 2 });

    await deleteAlbum(req({ params: { albumId: "2" } }), mockRes(), vi.fn());

    expect(removeStoredFiles).toHaveBeenCalledWith(["p1.jpg", "p2.jpg"]);
  });

  it("deleteAlbumPhoto removes that photo's file", async () => {
    prisma.photo.findUnique.mockResolvedValue({ id: 9, albumId: 2, fileUrl: "p9.jpg" });
    prisma.photo.delete.mockResolvedValue({});

    await deleteAlbumPhoto(req({ params: { albumId: "2", photoId: "9" } }), mockRes(), vi.fn());

    expect(removeStoredFiles).toHaveBeenCalledWith("p9.jpg");
  });

  it("deleteAlbumPhoto leaves the file alone when the photo belongs to another album", async () => {
    prisma.photo.findUnique.mockResolvedValue({ id: 9, albumId: 3, fileUrl: "p9.jpg" });

    const res = mockRes();
    await deleteAlbumPhoto(req({ params: { albumId: "2", photoId: "9" } }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(removeStoredFiles).not.toHaveBeenCalled();
  });

  it("deleteStudent removes the photo, every document, and every submission file", async () => {
    prisma.studentDocument.findMany.mockResolvedValue([{ fileUrl: "d1.pdf" }]);
    prisma.submission.findMany.mockResolvedValue([{ fileUrl: "s1.png" }]);
    prisma.student.delete.mockResolvedValue({ id: 4, photo: "face.jpg" });

    // Admin: bypasses the ownership check (assertCanAccessStudent) so this
    // test doesn't also need to mock a student.findUnique lookup.
    await deleteStudent(
      req({ params: { id: "4" }, user: { id: 1, role: "Admin" } }),
      mockRes(),
      vi.fn(),
    );

    expect(removeStoredFiles).toHaveBeenCalledWith("face.jpg", ["d1.pdf"], ["s1.png"]);
  });

  it("deleteStudent also erases the child's face enrollment from the recognition service", async () => {
    prisma.studentDocument.findMany.mockResolvedValue([]);
    prisma.submission.findMany.mockResolvedValue([]);
    prisma.student.delete.mockResolvedValue({ id: 4, photo: null });

    await deleteStudent(req({ params: { id: "4" }, user: { id: 1, role: "Admin" } }), mockRes(), vi.fn());

    expect(recognition.removeStudentEnrollment).toHaveBeenCalledWith(4);
  });

  it("deleteStudent still succeeds (204) if the recognition service is down", async () => {
    prisma.studentDocument.findMany.mockResolvedValue([]);
    prisma.submission.findMany.mockResolvedValue([]);
    prisma.student.delete.mockResolvedValue({ id: 4, photo: null });
    recognition.removeStudentEnrollment.mockRejectedValue(new Error("down"));
    const res = mockRes();

    await deleteStudent(req({ params: { id: "4" }, user: { id: 1, role: "Admin" } }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("deleteStudent skips the recognition call when the service isn't configured", async () => {
    prisma.studentDocument.findMany.mockResolvedValue([]);
    prisma.submission.findMany.mockResolvedValue([]);
    prisma.student.delete.mockResolvedValue({ id: 4, photo: null });
    recognition.isRecognitionConfigured.mockReturnValueOnce(false);

    await deleteStudent(req({ params: { id: "4" }, user: { id: 1, role: "Admin" } }), mockRes(), vi.fn());

    expect(recognition.removeStudentEnrollment).not.toHaveBeenCalled();
  });
});
