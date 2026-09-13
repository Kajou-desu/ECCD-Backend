import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { listUsers, registerUser, updateUser, deleteUser } = await import(
  "../src/controllers/users.controller.js"
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

describe("listUsers", () => {
  it("returns the user list without exposing password hashes", async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 1, firstName: "Ada", lastName: "Lovelace", name: "Ada Lovelace", email: "ada@example.com", role: "Teacher" },
    ]);

    const req = { user: { id: 9, role: "Admin" } };
    const res = mockRes();
    const next = vi.fn();

    await listUsers(req, res, next);

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ passwordHash: true }),
      }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ email: "ada@example.com" })]),
    );
    expect(next).not.toHaveBeenCalled();
  });
});

describe("registerUser", () => {
  const baseBody = {
    firstName: "Grace",
    lastName: "Hopper",
    middleName: "",
    email: "Grace@Example.com",
    password: "correct-horse-1",
    role: "Teacher",
  };

  it("creates an account with a hashed password and composed name", async () => {
    prisma.user.create.mockResolvedValue({ id: 2, ...baseBody, email: "grace@example.com" });

    const req = { body: { ...baseBody }, user: { id: 1, role: "Admin" } };
    const res = mockRes();
    const next = vi.fn();

    await registerUser(req, res, next);

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "grace@example.com", // canonicalized (lowercased)
          name: "Grace Hopper",
        }),
      }),
    );

    // Password is hashed, never stored/forwarded in plaintext.
    const createCallData = prisma.user.create.mock.calls[0][0].data;
    expect(createCallData.passwordHash).not.toBe(baseBody.password);
    expect(await bcrypt.compare(baseBody.password, createCallData.passwordHash)).toBe(true);
    expect(createCallData.password).toBeUndefined();

    expect(res.status).toHaveBeenCalledWith(201);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a non-Admin trying to grant the Admin role", async () => {
    const req = {
      body: { ...baseBody, role: "Admin" },
      user: { id: 1, role: "Teacher" },
    };
    const res = mockRes();
    const next = vi.fn();

    await registerUser(req, res, next);

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("allows an Admin to grant the Admin role", async () => {
    prisma.user.create.mockResolvedValue({ id: 3, ...baseBody, role: "Admin" });

    const req = {
      body: { ...baseBody, role: "Admin" },
      user: { id: 1, role: "Admin" },
    };
    const res = mockRes();
    const next = vi.fn();

    await registerUser(req, res, next);

    expect(prisma.user.create).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("rejects a weak password", async () => {
    const req = { body: { ...baseBody, password: "short" }, user: { id: 1, role: "Admin" } };
    const res = mockRes();
    const next = vi.fn();

    await registerUser(req, res, next);

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("returns 409 when the email is already registered", async () => {
    const conflict = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    prisma.user.create.mockRejectedValue(conflict);

    const req = { body: { ...baseBody }, user: { id: 1, role: "Admin" } };
    const res = mockRes();
    const next = vi.fn();

    await registerUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("updateUser", () => {
  it("blocks a non-Admin from editing an existing Admin account", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: "Admin", firstName: "A", lastName: "B" });

    const req = { body: { userId: 5, firstName: "Changed" }, user: { id: 1, role: "Teacher" } };
    const res = mockRes();
    const next = vi.fn();

    await updateUser(req, res, next);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("blocks a non-Admin from promoting an account to Admin", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: "Teacher", firstName: "A", lastName: "B" });

    const req = { body: { userId: 5, role: "Admin" }, user: { id: 1, role: "Teacher" } };
    const res = mockRes();
    const next = vi.fn();

    await updateUser(req, res, next);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("allows a Teacher to edit a non-Admin account", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 5,
      role: "Parent",
      firstName: "Old",
      middleName: null,
      lastName: "Name",
    });
    prisma.user.update.mockResolvedValue({ id: 5, firstName: "New", lastName: "Name", role: "Parent" });

    const req = {
      body: { userId: 5, firstName: "New", lastName: "Name", email: "new@example.com" },
      user: { id: 1, role: "Teacher" },
    };
    const res = mockRes();
    const next = vi.fn();

    await updateUser(req, res, next);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5 },
        data: expect.objectContaining({ firstName: "New", name: "New Name" }),
      }),
    );
    expect(res.json).toHaveBeenCalled();
  });

  it("returns 404 for a missing account", async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const req = { body: { userId: 999 }, user: { id: 1, role: "Admin" } };
    const res = mockRes();
    const next = vi.fn();

    await updateUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("deleteUser", () => {
  it("prevents an account from deleting itself", async () => {
    const req = { params: { id: "1" }, user: { id: 1, role: "Admin" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteUser(req, res, next);

    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("blocks a non-Admin from deleting an Admin account", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: "Admin" });

    const req = { params: { id: "5" }, user: { id: 1, role: "Teacher" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteUser(req, res, next);

    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("deletes a non-Admin account", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: "Parent" });
    prisma.user.delete.mockResolvedValue({});

    const req = { params: { id: "5" }, user: { id: 1, role: "Teacher" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteUser(req, res, next);

    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 5 } });
    expect(res.status).toHaveBeenCalledWith(204);
  });
});
