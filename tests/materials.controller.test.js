import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    material: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
  },
}));
vi.mock("../src/middleware/upload.js", () => ({ fileUrl: vi.fn((_req, name) => name) }));
vi.mock("../src/lib/signedFileUrl.js", () => ({ signFileUrl: (_req, value) => value }));
vi.mock("../src/lib/fileStorage.js", () => ({ removeStoredFiles: vi.fn() }));

const { prisma } = await import("../src/lib/prisma.js");
const { getMaterials, createMaterial, updateMaterial } = await import("../src/controllers/materials.controller.js");

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  return res;
}

const TEACHER = { id: 1, role: "Teacher", centerId: 4 };
const ADMIN = { id: 2, role: "Admin", centerId: null };
const PARENT = { id: 3, role: "Parent", centerId: 4 };
const material = { id: 5, title: "Shapes", category: "Math", description: null, fileUrl: null, centerId: 4 };

beforeEach(() => vi.clearAllMocks());

describe("materials are per center", () => {
  describe("who sees which materials", () => {
    it.each([
      ["a Teacher", TEACHER, { centerId: 4 }],
      ["a Parent", PARENT, { centerId: 4 }],
      ["a Guardian", { ...PARENT, role: "Guardian" }, { centerId: 4 }],
      ["an Admin", ADMIN, {}],
    ])("%s is limited to %j", async (_name, user, where) => {
      prisma.material.findMany.mockResolvedValue([material]);
      const res = mockRes();

      await getMaterials({ user, query: {} }, res, vi.fn());

      expect(prisma.material.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
      expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 5, centerId: 4 })]);
    });

    it("ignores a centerId in the query, so nobody can ask for another center's list", async () => {
      prisma.material.findMany.mockResolvedValue([]);

      await getMaterials({ user: TEACHER, query: { centerId: "9" } }, mockRes(), vi.fn());

      expect(prisma.material.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { centerId: 4 } }));
    });

    it("returns nothing, without querying, to a user with no center or any other role", async () => {
      for (const user of [{ id: 5, role: "Teacher", centerId: null }, { id: 6, role: "Student", centerId: 4 }, undefined]) {
        const res = mockRes();
        await getMaterials({ user, query: {} }, res, vi.fn());
        expect(res.json).toHaveBeenCalledWith([]);
      }
      expect(prisma.material.findMany).not.toHaveBeenCalled();
    });

    it("counts only the caller's own center when paginating", async () => {
      prisma.material.findMany.mockResolvedValue([material]);
      prisma.material.count.mockResolvedValue(1);
      const res = mockRes();

      await getMaterials({ user: TEACHER, query: { page: "2", pageSize: "10" } }, res, vi.fn());

      expect(prisma.material.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { centerId: 4 }, skip: 10, take: 10 }),
      );
      expect(prisma.material.count).toHaveBeenCalledWith({ where: { centerId: 4 } });
      expect(res.set).toHaveBeenCalledWith("X-Total-Count", "1");
    });

    it("reports a total of 0 to a user with no center", async () => {
      const res = mockRes();
      await getMaterials(
        { user: { id: 5, role: "Teacher", centerId: null }, query: { page: "1", pageSize: "10" } },
        res,
        vi.fn(),
      );
      expect(res.set).toHaveBeenCalledWith("X-Total-Count", "0");
      expect(prisma.material.count).not.toHaveBeenCalled();
    });

    it("passes a database failure on to the error handler", async () => {
      const boom = new Error("db down");
      prisma.material.findMany.mockRejectedValue(boom);
      const next = vi.fn();

      await getMaterials({ user: TEACHER, query: {} }, mockRes(), next);

      expect(next).toHaveBeenCalledWith(boom);
    });
  });

  describe("creating a material", () => {
    const body = { title: "Shapes", category: "Math", description: "Circles" };

    it("puts a Teacher's material in their own center, whatever the body says", async () => {
      prisma.material.create.mockResolvedValue(material);
      const res = mockRes();

      await createMaterial({ user: TEACHER, body: { ...body, centerId: "99" } }, res, vi.fn());

      expect(prisma.material.create.mock.calls[0][0].data).toEqual({
        title: "Shapes",
        category: "Math",
        description: "Circles",
        centerId: 4,
        fileUrl: null,
      });
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it("makes an Admin name the center, and uses it (multipart sends it as a string)", async () => {
      prisma.material.create.mockResolvedValue({ ...material, centerId: 7 });

      const next = vi.fn();
      await createMaterial({ user: ADMIN, body }, mockRes(), next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
      expect(prisma.material.create).not.toHaveBeenCalled();

      await createMaterial({ user: ADMIN, body: { ...body, centerId: "7" } }, mockRes(), vi.fn());
      expect(prisma.material.create.mock.calls[0][0].data.centerId).toBe(7);
    });

    it("refuses a Teacher with no center, with a clear message, and every other role", async () => {
      const next = vi.fn();
      await createMaterial({ user: { id: 5, role: "Teacher", centerId: null }, body }, mockRes(), next);
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ status: 403, message: expect.stringContaining("not assigned to a center") }),
      );

      for (const user of [PARENT, undefined]) {
        const denied = vi.fn();
        await createMaterial({ user, body }, mockRes(), denied);
        expect(denied).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
      }
      expect(prisma.material.create).not.toHaveBeenCalled();
    });

    it("answers 400 when an Admin names a center that does not exist", async () => {
      prisma.material.create.mockRejectedValue(Object.assign(new Error("fk"), { code: "P2003" }));
      const res = mockRes();

      await createMaterial({ user: ADMIN, body: { ...body, centerId: 999 } }, res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: "Center not found" });
    });
  });

  describe("changing a material", () => {
    it("is 'not found' for a material of another center, and changes nothing", async () => {
      prisma.material.update.mockRejectedValue(Object.assign(new Error("none"), { code: "P2025" }));
      const res = mockRes();

      await updateMaterial({ user: TEACHER, params: { id: "5" }, body: { title: "T" } }, res, vi.fn());

      expect(prisma.material.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 5, centerId: 4 } }));
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ message: "Material not found" });
    });

    it("never moves a material to another center, even if the body asks", async () => {
      prisma.material.update.mockResolvedValue(material);

      await updateMaterial({ user: TEACHER, params: { id: "5" }, body: { title: "T", centerId: 9 } }, mockRes(), vi.fn());
      await updateMaterial({ user: ADMIN, params: { id: "5" }, body: { title: "T", centerId: 9 } }, mockRes(), vi.fn());

      for (const [args] of prisma.material.update.mock.calls) {
        expect(args.data).toEqual({ title: "T" });
      }
    });

    it("lets an Admin change any material", async () => {
      prisma.material.update.mockResolvedValue(material);

      await updateMaterial({ user: ADMIN, params: { id: "5" }, body: { title: "T" } }, mockRes(), vi.fn());

      expect(prisma.material.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 5 } }));
    });

    it("refuses a Teacher with no center and a Parent, before touching the database", async () => {
      for (const user of [{ id: 5, role: "Teacher", centerId: null }, PARENT]) {
        const next = vi.fn();
        await updateMaterial({ user, params: { id: "5" }, body: { title: "T" } }, mockRes(), next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
      }
      expect(prisma.material.update).not.toHaveBeenCalled();
    });
  });
});
