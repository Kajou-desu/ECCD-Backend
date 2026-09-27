import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    album: { findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    event: { findUnique: vi.fn() },
    material: { findUnique: vi.fn() },
  },
}));
vi.mock("../src/middleware/upload.js", () => ({ fileUrl: vi.fn() }));
vi.mock("../src/lib/signedFileUrl.js", () => ({ signFileUrl: (_req, value) => value }));
vi.mock("../src/lib/fileStorage.js", () => ({ removeStoredFiles: vi.fn() }));

const { prisma } = await import("../src/lib/prisma.js");
const { createAlbum, getAlbums } = await import("../src/controllers/albums.controller.js");

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => vi.clearAllMocks());

describe("album associations", () => {
  it("persists an event association and returns its title", async () => {
    prisma.event.findUnique.mockResolvedValue({ id: 8 });
    prisma.album.create.mockResolvedValue({
      id: 3,
      title: "Family Day Photos",
      event: { id: 8, title: "Family Day" },
      activity: null,
      photos: [],
    });
    const res = mockRes();

    await createAlbum(
      { body: { title: "Family Day Photos", associationType: "event", associationId: "8" } },
      res,
      vi.fn(),
    );

    expect(prisma.album.create).toHaveBeenCalledWith(expect.objectContaining({
      data: { title: "Family Day Photos", eventId: 8, materialId: null },
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      association: { type: "event", id: 8, title: "Family Day" },
      associationName: "Family Day",
    }));
  });

  it("returns activity titles for existing albums", async () => {
    prisma.album.findMany.mockResolvedValue([{
      id: 4,
      title: "Counting Activity Photos",
      event: null,
      activity: { id: 11, title: "Counting to Ten" },
      photos: [],
    }]);
    const res = mockRes();

    await getAlbums({ query: {} }, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({
        association: { type: "activity", id: 11, title: "Counting to Ten" },
        associationName: "Counting to Ten",
      }),
    ]);
  });
});