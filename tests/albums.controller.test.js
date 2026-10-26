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

// Albums belong to a center; a Teacher only ever works inside their own.
const TEACHER = { id: 1, role: "Teacher", centerId: 4 };

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
      { user: TEACHER, body: { title: "Family Day Photos", associationType: "event", associationId: "8" } },
      res,
      vi.fn(),
    );

    expect(prisma.album.create).toHaveBeenCalledWith(expect.objectContaining({
      data: { title: "Family Day Photos", description: null, centerId: 4, eventId: 8, materialId: null },
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

    await getAlbums({ user: TEACHER, query: {} }, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({
        association: { type: "activity", id: 11, title: "Counting to Ten" },
        associationName: "Counting to Ten",
      }),
    ]);
  });

  it("updates an album's association to an activity", async () => {
    prisma.album.findUnique.mockResolvedValue({ centerId: 4 });
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
      { user: TEACHER, params: { albumId: "4" }, body: { title: "Counting Activity Photos", associationType: "activity", associationId: "11" } },
      res,
      vi.fn(),
    );

    // The activity has to be one of the album's own center's.
    expect(prisma.material.findUnique).toHaveBeenCalledWith({ where: { id: 11, centerId: 4 }, select: { id: true } });
    expect(prisma.album.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 4, centerId: 4 },
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
      { user: TEACHER, body: { title: "T", description: "  Fun day ", associationType: "event", associationId: 8 } },
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
        { user: TEACHER, body: { title: "T", description, associationType: "event", associationId: 8 } },
        mockRes(),
        next,
      );
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    }
    expect(prisma.album.create).not.toHaveBeenCalled();
  });

  it("updates the description only when it is sent, and clears it on blank", async () => {
    prisma.album.update.mockResolvedValue({ ...created, description: null });

    await updateAlbum({ user: TEACHER, params: { albumId: "1" }, body: { title: "T" } }, mockRes(), vi.fn());
    expect(prisma.album.update.mock.calls[0][0].data).toEqual({ title: "T" });

    await updateAlbum({ user: TEACHER, params: { albumId: "1" }, body: { title: "T", description: "  " } }, mockRes(), vi.fn());
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

    await addAlbumPhotos({ user: TEACHER, params: { albumId: "1" }, files }, res, vi.fn());

    const captions = prisma.photo.create.mock.calls.map(([args]) => args.data.caption);
    expect(captions[0]).toBe("badname.jpg");
    expect(captions[1]).toHaveLength(255);
  });
});

describe("albums are per center", () => {
  const ADMIN = { id: 2, role: "Admin", centerId: null };
  const PARENT = { id: 3, role: "Parent", centerId: 4 };
  const album = { id: 4, title: "A", event: null, activity: null, photos: [] };

  describe("who sees which albums", () => {
    it.each([
      ["a Teacher", TEACHER, { centerId: 4 }],
      ["a Parent", PARENT, { centerId: 4 }],
      ["a Guardian", { ...PARENT, role: "Guardian" }, { centerId: 4 }],
      ["an Admin", ADMIN, {}],
    ])("%s is limited to %j", async (_name, user, where) => {
      prisma.album.findMany.mockResolvedValue([album]);

      await getAlbums({ user, query: {} }, mockRes(), vi.fn());

      expect(prisma.album.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    });

    it("returns nothing, without querying, to a user with no center or any other role", async () => {
      for (const user of [{ id: 5, role: "Teacher", centerId: null }, { id: 6, role: "Student", centerId: 4 }, undefined]) {
        const res = mockRes();
        await getAlbums({ user, query: {} }, res, vi.fn());
        expect(res.json).toHaveBeenCalledWith([]);
      }
      expect(prisma.album.findMany).not.toHaveBeenCalled();
    });

    it("counts only the caller's own center when paginating", async () => {
      prisma.album.findMany.mockResolvedValue([album]);
      prisma.album.count.mockResolvedValue(1);
      const res = mockRes();

      await getAlbums({ user: TEACHER, query: { page: "1", pageSize: "10" } }, res, vi.fn());

      expect(prisma.album.count).toHaveBeenCalledWith({ where: { centerId: 4 } });
      expect(res.set).toHaveBeenCalledWith("X-Total-Count", "1");
    });

    it("reports a total of 0 to a user with no center", async () => {
      const res = mockRes();
      await getAlbums({ user: { id: 5, role: "Teacher", centerId: null }, query: { page: "1", pageSize: "10" } }, res, vi.fn());
      expect(res.set).toHaveBeenCalledWith("X-Total-Count", "0");
      expect(prisma.album.count).not.toHaveBeenCalled();
    });
  });

  describe("creating an album", () => {
    const body = { title: "T", associationType: "event", associationId: 8 };

    it("puts a Teacher's album in their own center, whatever the body says", async () => {
      prisma.event.findUnique.mockResolvedValue({ id: 8 });
      prisma.album.create.mockResolvedValue(album);

      await createAlbum({ user: TEACHER, body: { ...body, centerId: 99 } }, mockRes(), vi.fn());

      expect(prisma.album.create.mock.calls[0][0].data.centerId).toBe(4);
    });

    it("makes an Admin name the center, and uses it", async () => {
      prisma.event.findUnique.mockResolvedValue({ id: 8 });
      prisma.album.create.mockResolvedValue(album);

      const next = vi.fn();
      await createAlbum({ user: ADMIN, body }, mockRes(), next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
      expect(prisma.album.create).not.toHaveBeenCalled();

      await createAlbum({ user: ADMIN, body: { ...body, centerId: "7" } }, mockRes(), vi.fn());
      expect(prisma.album.create.mock.calls[0][0].data.centerId).toBe(7);
    });

    it("refuses a Teacher with no center, and every other role", async () => {
      for (const [user, status] of [[{ id: 5, role: "Teacher", centerId: null }, 403], [PARENT, 403], [undefined, 403]]) {
        const next = vi.fn();
        await createAlbum({ user, body }, mockRes(), next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status }));
      }
      expect(prisma.album.create).not.toHaveBeenCalled();
    });

    it("only lets an album be connected to an activity of its own center", async () => {
      prisma.material.findUnique.mockResolvedValue(null); // another center's activity: not in scope

      const next = vi.fn();
      await createAlbum(
        { user: TEACHER, body: { title: "T", associationType: "activity", associationId: 11 } },
        mockRes(),
        next,
      );

      expect(prisma.material.findUnique).toHaveBeenCalledWith({ where: { id: 11, centerId: 4 }, select: { id: true } });
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
      expect(prisma.album.create).not.toHaveBeenCalled();
    });

    it("answers 400 when an Admin names a center that does not exist", async () => {
      prisma.event.findUnique.mockResolvedValue({ id: 8 });
      prisma.album.create.mockRejectedValue(Object.assign(new Error("fk"), { code: "P2003" }));
      const res = mockRes();

      await createAlbum({ user: ADMIN, body: { ...body, centerId: 999 } }, res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: "Center not found" });
    });
  });

  describe("changing an album", () => {
    it("is 'not found' for an album of another center, and changes nothing", async () => {
      prisma.album.update.mockRejectedValue(Object.assign(new Error("none"), { code: "P2025" }));
      const res = mockRes();

      await updateAlbum({ user: TEACHER, params: { albumId: "4" }, body: { title: "T" } }, res, vi.fn());

      expect(prisma.album.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 4, centerId: 4 } }));
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it("does not look at the activity at all when the album is not the caller's", async () => {
      prisma.album.findUnique.mockResolvedValue(null);
      const next = vi.fn();

      await updateAlbum(
        { user: TEACHER, params: { albumId: "4" }, body: { title: "T", associationType: "activity", associationId: "11" } },
        mockRes(),
        next,
      );

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
      expect(prisma.material.findUnique).not.toHaveBeenCalled();
      expect(prisma.album.update).not.toHaveBeenCalled();
    });

    it("never moves an album to another center, even if the body asks", async () => {
      prisma.album.update.mockResolvedValue(album);

      await updateAlbum({ user: TEACHER, params: { albumId: "4" }, body: { title: "T", centerId: 9 } }, mockRes(), vi.fn());

      expect(prisma.album.update.mock.calls[0][0].data).toEqual({ title: "T" });
    });

    it("lets an Admin work on any album, taking the activity's center from the album", async () => {
      prisma.album.findUnique.mockResolvedValue({ centerId: 7 });
      prisma.material.findUnique.mockResolvedValue({ id: 11 });
      prisma.album.update.mockResolvedValue(album);

      await updateAlbum(
        { user: ADMIN, params: { albumId: "4" }, body: { title: "T", associationType: "activity", associationId: "11" } },
        mockRes(),
        vi.fn(),
      );

      expect(prisma.album.findUnique).toHaveBeenCalledWith({ where: { id: 4 }, select: { centerId: true } });
      expect(prisma.material.findUnique).toHaveBeenCalledWith({ where: { id: 11, centerId: 7 }, select: { id: true } });
      expect(prisma.album.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 4 } }));
    });
  });

  describe("adding photos", () => {
    const files = [{ filename: "a.jpg", originalname: "a.jpg" }];

    it("looks the album up inside the caller's center and adds nothing to another center's", async () => {
      prisma.album.findUnique.mockResolvedValue(null);
      const res = mockRes();

      await addAlbumPhotos({ user: TEACHER, params: { albumId: "9" }, files }, res, vi.fn());

      expect(prisma.album.findUnique).toHaveBeenCalledWith({ where: { id: 9, centerId: 4 } });
      expect(res.status).toHaveBeenCalledWith(404);
      expect(prisma.photo.create).not.toHaveBeenCalled();
    });

    it("refuses a Teacher with no center and a Parent, before touching the database", async () => {
      for (const user of [{ id: 5, role: "Teacher", centerId: null }, PARENT]) {
        const next = vi.fn();
        await addAlbumPhotos({ user, params: { albumId: "9" }, files }, mockRes(), next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
      }
      expect(prisma.album.findUnique).not.toHaveBeenCalled();
    });
  });
});
