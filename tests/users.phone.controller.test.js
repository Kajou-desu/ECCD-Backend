import { describe, it, expect, vi, beforeEach } from "vitest";

const tx = {
  user: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  parentChild: { deleteMany: vi.fn(), createMany: vi.fn() },
  student: { findMany: vi.fn() },
};
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn((cb) => cb(tx)),
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { AppError } = await import("../src/middleware/errorHandler.js");
const { registerUser, updateUser, updateMyProfile } = await import(
  "../src/controllers/users.controller.js"
);

const LANDLINE = "02-8123-4567";
const MOBILE = "0917 123 4567";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const savedUser = { id: 9, firstName: "A", lastName: "B", name: "A B", email: "a@example.com", profilePicture: null };

beforeEach(() => {
  vi.clearAllMocks();
  tx.user.create.mockResolvedValue({ id: 9 });
  tx.user.update.mockResolvedValue(savedUser);
  tx.user.findUnique.mockResolvedValue(savedUser);
  tx.student.findMany.mockResolvedValue([]);
  prisma.user.update.mockResolvedValue(savedUser);
});

function registerReq(role, phone) {
  return {
    user: { id: 1, role: "Admin" },
    body: { firstName: "A", lastName: "B", email: "a@example.com", password: "Str0ng!Passw0rd#1", role, phone },
  };
}

describe("registerUser phone rule", () => {
  it.each(["Parent", "Guardian"])("rejects a non-mobile phone for a %s (they receive SMS)", async (role) => {
    const next = vi.fn();
    await registerUser(registerReq(role, LANDLINE), mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].message).toMatch(/Philippine mobile/);
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it("accepts a PH mobile for a Parent", async () => {
    const next = vi.fn();
    await registerUser(registerReq("Parent", MOBILE), mockRes(), next);

    expect(next).not.toHaveBeenCalled();
    expect(tx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ phone: MOBILE }) })
    );
  });

  it("still allows a landline for a Teacher (they never receive SMS)", async () => {
    const next = vi.fn();
    await registerUser(registerReq("Teacher", LANDLINE), mockRes(), next);

    expect(next).not.toHaveBeenCalled();
    expect(tx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ phone: LANDLINE }) })
    );
  });
});

describe("updateUser phone rule", () => {
  it("validates against the role the account will have after the update", async () => {
    // A Teacher being converted to a Parent must already have an SMS-capable number.
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: "Teacher", email: "t@example.com" });
    const next = vi.fn();

    await updateUser(
      { user: { id: 1, role: "Admin" }, body: { userId: 5, role: "Parent", phone: LANDLINE } },
      mockRes(),
      next
    );

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("rejects a landline when editing an existing Parent's phone", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: "Parent", email: "p@example.com" });
    const next = vi.fn();

    await updateUser({ user: { id: 1, role: "Admin" }, body: { userId: 5, phone: LANDLINE } }, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
  });
});

describe("updateMyProfile phone rule", () => {
  it("rejects a landline for a signed-in Parent", async () => {
    const next = vi.fn();
    await updateMyProfile({ user: { id: 3, role: "Parent" }, body: { phone: LANDLINE } }, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("saves a PH mobile for a signed-in Parent", async () => {
    const next = vi.fn();
    await updateMyProfile({ user: { id: 3, role: "Parent" }, body: { phone: MOBILE } }, mockRes(), next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { phone: MOBILE } })
    );
  });

  it("still accepts a landline for a signed-in Teacher", async () => {
    const next = vi.fn();
    await updateMyProfile({ user: { id: 4, role: "Teacher" }, body: { phone: LANDLINE } }, mockRes(), next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalled();
  });
});
