import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    center: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { listCenters, createCenter, renameCenter } = await import("../src/controllers/centers.controller.js");

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => vi.clearAllMocks());

describe("listCenters", () => {
  it("gives an Admin every center", async () => {
    prisma.center.findMany.mockResolvedValue([{ id: 1, name: "A" }, { id: 2, name: "B" }]);
    const res = mockRes();

    await listCenters({ user: { id: 1, role: "Admin" } }, res, vi.fn());

    expect(prisma.center.findMany.mock.calls[0][0].where).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith([{ id: 1, name: "A" }, { id: 2, name: "B" }]);
  });

  it("gives a Teacher only their own center", async () => {
    prisma.center.findMany.mockResolvedValue([{ id: 2, name: "B" }]);

    await listCenters({ user: { id: 7, role: "Teacher", centerId: 2 } }, mockRes(), vi.fn());

    expect(prisma.center.findMany.mock.calls[0][0].where).toEqual({ id: 2 });
  });

  it("gives a Teacher with no center nothing (never every center)", async () => {
    prisma.center.findMany.mockResolvedValue([]);

    await listCenters({ user: { id: 7, role: "Teacher", centerId: null } }, mockRes(), vi.fn());

    expect(prisma.center.findMany.mock.calls[0][0].where).toEqual({ id: -1 });
  });
});

describe("createCenter", () => {
  it("creates a center with a tidied name", async () => {
    prisma.center.findFirst.mockResolvedValue(null);
    prisma.center.create.mockResolvedValue({ id: 5, name: "ECCD Angeles" });
    const res = mockRes();

    await createCenter({ body: { name: "  ECCD   Angeles " } }, res, vi.fn());

    expect(prisma.center.create.mock.calls[0][0].data).toEqual({ name: "ECCD Angeles" });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("refuses a name that already exists in any letter case", async () => {
    prisma.center.findFirst.mockResolvedValue({ id: 1 });
    const next = vi.fn();

    await createCenter({ body: { name: "eccd angeles" } }, mockRes(), next);

    expect(prisma.center.findFirst.mock.calls[0][0].where.name).toEqual({ equals: "eccd angeles", mode: "insensitive" });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 409, message: 'A center named "eccd angeles" already exists.' }));
    expect(prisma.center.create).not.toHaveBeenCalled();
  });

  it.each([[""], ["   "], [null], [42], ["x".repeat(101)]])("refuses the name %j", async (name) => {
    const next = vi.fn();

    await createCenter({ body: { name } }, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400, message: expect.stringMatching(/Enter the center's name/) }));
    expect(prisma.center.create).not.toHaveBeenCalled();
  });
});

describe("renameCenter", () => {
  it("renames, ignoring the center's own current name when checking for duplicates", async () => {
    prisma.center.findFirst.mockResolvedValue(null);
    prisma.center.update.mockResolvedValue({ id: 5, name: "ECCD Angeles City" });

    await renameCenter({ params: { id: "5" }, body: { name: "ECCD Angeles City" } }, mockRes(), vi.fn());

    expect(prisma.center.findFirst.mock.calls[0][0].where.id).toEqual({ not: 5 });
    expect(prisma.center.update.mock.calls[0][0].where).toEqual({ id: 5 });
  });

  it("answers 404 for a center that does not exist", async () => {
    prisma.center.findFirst.mockResolvedValue(null);
    prisma.center.update.mockRejectedValue(Object.assign(new Error("none"), { code: "P2025" }));
    const next = vi.fn();

    await renameCenter({ params: { id: "99" }, body: { name: "X" } }, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });
});
