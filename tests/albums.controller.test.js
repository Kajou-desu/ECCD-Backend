import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    album: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    photo: { create: vi.fn((args) => args) },
    $transaction: vi.fn((ops) => Promise.all(ops)),
    event: { findUnique: vi.fn() },
    material: { findUnique: vi.fn() },
  },
}));
vi.mock("../src/middleware/upload.js", () => ({ fileUrl: vi.fn((_req, name) => name) }));
vi.mock("../src/lib/signedFileUrl.js", () => ({ signFileUrl: (_req, value) => value }));
vi.mock("../src/lib/fileStorage.js", () => ({ removeStoredFiles: vi.fn() }));

const { prisma } = await import("../src/lib/prisma.js");
const { createAlbum, getAlbums, updateAlbum, addAlbumPhotos } = await import("../src/controllers/albums.controller.js");

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
      data: { title: "Family Day Photos", description: null, eventId: 8, materialId: null },
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

  it("updates an album's association to an activity", async () => {
    prisma.material.findUnique.mockResolvedValue({ id: 11 });
    prisma.album.update.mockResolvedValue({
      id: 4,
      title: "Counting Activity Photos",
      event: null,
      activity: { id: 11, title: "Counting to Ten" },
      photos: [],
    });
    const res = mockRes();

    await updateAlbum(
      { params: { albumId: "4" }, body: { title: "Counting Activity Photos", associationType: "activity", associationId: "11" } },
      res,
      vi.fn(),
    );

    expect(prisma.album.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 4 },
      data: { title: "Counting Activity Photos", eventId: null, materialId: 11 },
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      association: { type: "activity", id: 11, title: "Counting to Ten" },
    }));
  });
});
describe("album description", () => {
  const created = { id: 1, title: "T", event: null, activity: null, photos: [] };

  it("stores an optional description on create", async () => {
    prisma.event.findUnique.mockResolvedValue({ id: 8 });
    prisma.album.create.mockResolvedValue({ ...created, description: "Fun day" });
    const res = mockRes();

    await createAlbum(
      { body: { title: "T", description: "  Fun day ", associationType: "event", associationId: 8 } },
      res,
      vi.fn(),
    );

    expect(prisma.album.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ description: "Fun day" }),
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ description: "Fun day" }));
  });

  it("rejects a description over 1000 characters or a non-string", async () => {
    for (const description of ["a".repeat(1001), 5]) {
      const next = vi.fn();
      await createAlbum(
        { body: { title: "T", description, associationType: "event", associationId: 8 } },
        mockRes(),
        next,
      );
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    }
    expect(prisma.album.create).not.toHaveBeenCalled();
  });

  it("updates the description only when it is sent, and clears it on blank", async () => {
    prisma.album.update.mockResolvedValue({ ...created, description: null });

    await updateAlbum({ params: { albumId: "1" }, body: { title: "T" } }, mockRes(), vi.fn());
    expect(prisma.album.update.mock.calls[0][0].data).toEqual({ title: "T" });

    await updateAlbum({ params: { albumId: "1" }, body: { title: "T", description: "  " } }, mockRes(), vi.fn());
    expect(prisma.album.update.mock.calls[1][0].data).toEqual({ title: "T", description: null });
  });
});

describe("photo captions", () => {
  it("strips control characters and caps the caption at 255 characters", async () => {
    prisma.album.findUnique.mockResolvedValue({ id: 1 });
    const res = mockRes();
    const files = [
      { filename: "a.jpg", originalname: "bad\nname\u0000\u0007.jpg" },
      { filename: "b.jpg", originalname: `${"x".repeat(400)}.jpg` },
    ];

    await addAlbumPhotos({ params: { albumId: "1" }, files }, res, vi.fn());

    const captions = prisma.photo.create.mock.calls.map(([args]) => args.data.caption);
    expect(captions[0]).toBe("badname.jpg");
    expect(captions[1]).toHaveLength(255);
  });
});
