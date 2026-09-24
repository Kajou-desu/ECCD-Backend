import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    parentChild: {
      createMany: vi.fn(),
    },
    accountActionOtp: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    // registerUser/updateUser run inside prisma.$transaction((tx) => ...).
    // `prisma` (declared right below) is the very object this factory
    // returns, so passing it as `tx` keeps every existing
    // prisma.user.*/parentChild.* mock and assertion working unchanged.
    // The reference is only read once $transaction is actually called
    // (well after `prisma` is assigned below), so this is safe despite
    // looking circular.
    $transaction: vi.fn((callback) => callback(prisma)),
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const {
  listUsers,
  registerUser,
  updateUser,
  deleteUser,
  updateMyProfile,
  changeMyPassword,
  deleteMyAccount,
  uploadMyProfilePhoto,
} = await import("../src/controllers/users.controller.js");

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
}

const VALID_OTP = "123456";

// changeMyPassword/deleteMyAccount now require a verified OTP before doing
// anything else; stub a matching, unexpired, unused-attempt record so
// tests written before that requirement can still exercise the rest of
// each function's behavior.
function mockValidOtp() {
  prisma.accountActionOtp.findFirst.mockResolvedValue({
    id: 1,
    otpCode: VALID_OTP,
    expiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
  });
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

  it("excludes Admin accounts for Teachers", async () => {
    prisma.user.findMany.mockResolvedValue([]);

    const req = { user: { id: 9, role: "Teacher" } };
    const res = mockRes();
    const next = vi.fn();

    await listUsers(req, res, next);

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: { not: "Admin" } } }),
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
    prisma.user.findUnique.mockResolvedValue({ id: 2, ...baseBody, email: "grace@example.com", children: [] });

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
    prisma.user.findUnique.mockResolvedValue({ id: 3, ...baseBody, role: "Admin", children: [] });

    const req = {
      body: { ...baseBody, role: "Admin" },
      user: { id: 1, role: "Admin" },
    };
    const res = mockRes();
    const next = vi.fn();

    await registerUser(req, res, next);

    expect(prisma.user.create).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(next).not.toHaveBeenCalled();
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

  it("allows a Teacher to edit a parent/guardian account", async () => {
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

  it("blocks a Teacher from editing another Teacher account", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: "Teacher" });

    const req = { body: { userId: 5, firstName: "Changed" }, user: { id: 1, role: "Teacher" } };
    const res = mockRes();
    const next = vi.fn();

    await updateUser(req, res, next);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
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

  it("deletes a parent/guardian account", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: "Parent" });
    prisma.user.delete.mockResolvedValue({});

    const req = { params: { id: "5" }, user: { id: 1, role: "Teacher" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteUser(req, res, next);

    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 5 } });
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("blocks a Teacher from deleting another Teacher account", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: "Teacher" });

    const req = { params: { id: "5" }, user: { id: 1, role: "Teacher" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteUser(req, res, next);

    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("deleteMyAccount", () => {
  it("requires a password in the body", async () => {
    const req = { body: {}, user: { id: 1, role: "Parent" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteMyAccount(req, res, next);

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects an incorrect password", async () => {
    const passwordHash = await bcrypt.hash("correct-horse-1", 10);
    prisma.user.findUnique.mockResolvedValue({ id: 1, role: "Parent", passwordHash });
    mockValidOtp();

    const req = { body: { password: "wrong-password", otpCode: VALID_OTP }, user: { id: 1, role: "Parent" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteMyAccount(req, res, next);

    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("deletes a non-Admin account with the correct password", async () => {
    const passwordHash = await bcrypt.hash("correct-horse-1", 10);
    prisma.user.findUnique.mockResolvedValue({ id: 1, role: "Parent", passwordHash });
    prisma.user.delete.mockResolvedValue({});
    mockValidOtp();

    const req = { body: { password: "correct-horse-1", otpCode: VALID_OTP }, user: { id: 1, role: "Parent" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteMyAccount(req, res, next);

    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("blocks the last remaining Admin from self-deleting", async () => {
    const passwordHash = await bcrypt.hash("correct-horse-1", 10);
    prisma.user.findUnique.mockResolvedValue({ id: 1, role: "Admin", passwordHash });
    prisma.user.count.mockResolvedValue(1);
    mockValidOtp();

    const req = { body: { password: "correct-horse-1", otpCode: VALID_OTP }, user: { id: 1, role: "Admin" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteMyAccount(req, res, next);

    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("allows an Admin to self-delete when other Admins remain", async () => {
    const passwordHash = await bcrypt.hash("correct-horse-1", 10);
    prisma.user.findUnique.mockResolvedValue({ id: 1, role: "Admin", passwordHash });
    prisma.user.count.mockResolvedValue(2);
    prisma.user.delete.mockResolvedValue({});
    mockValidOtp();

    const req = { body: { password: "correct-horse-1", otpCode: VALID_OTP }, user: { id: 1, role: "Admin" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteMyAccount(req, res, next);

    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(res.status).toHaveBeenCalledWith(204);
  });
});

describe("updateMyProfile", () => {
  async function accountWithPassword(email = "old@example.com") {
    prisma.user.findUnique.mockResolvedValue({
      id: 3,
      email,
      passwordHash: await bcrypt.hash("current-pass-123", 10),
    });
  }

  it("updates only the caller's own account, never accepting a role change", async () => {
    await accountWithPassword();
    prisma.user.update.mockResolvedValue({ id: 3, firstName: "New", email: "new@example.com" });

    const req = {
      body: {
        firstName: "New",
        email: "New@Example.com",
        role: "Admin",
        currentPassword: "current-pass-123",
      },
      user: { id: 3, role: "Parent" },
    };
    const res = mockRes();
    const next = vi.fn();

    await updateMyProfile(req, res, next);

    const call = prisma.user.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 3 });
    expect(call.data.email).toBe("new@example.com");
    expect(call.data.role).toBeUndefined(); // role is never accepted here
    expect(call.data.currentPassword).toBeUndefined(); // never written to the row
    expect(res.json).toHaveBeenCalled();
  });

  it("refuses an email change without the current password (session-hijack takeover)", async () => {
    await accountWithPassword();

    const req = { body: { email: "attacker@example.com" }, user: { id: 3, role: "Parent" } };
    const res = mockRes();
    await updateMyProfile(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses an email change with a wrong current password", async () => {
    await accountWithPassword();

    const req = {
      body: { email: "attacker@example.com", currentPassword: "wrong-password-1" },
      user: { id: 3, role: "Parent" },
    };
    const res = mockRes();
    await updateMyProfile(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("does not ask for the password when the email is unchanged (the form always resends it)", async () => {
    await accountWithPassword("same@example.com");
    prisma.user.update.mockResolvedValue({ id: 3, email: "same@example.com", phone: "0917 000 0000" });

    const req = {
      body: { email: "Same@Example.com", phone: "0917 000 0000" },
      user: { id: 3, role: "Parent" },
    };
    const res = mockRes();
    await updateMyProfile(req, res, vi.fn());

    expect(prisma.user.update).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it("does not ask for the password when the email isn't part of the update", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 3, firstName: "A", lastName: "B", middleName: null });
    prisma.user.update.mockResolvedValue({ id: 3, phone: "0917 000 0000" });

    const req = { body: { phone: "0917 000 0000" }, user: { id: 3, role: "Parent" } };
    const res = mockRes();
    await updateMyProfile(req, res, vi.fn());

    expect(prisma.user.update).toHaveBeenCalledOnce();
  });
});

describe("changeMyPassword", () => {
  it("requires the current password", async () => {
    const req = { body: { newPassword: "brand-new-pass-1" }, user: { id: 1, role: "Parent" } };
    const res = mockRes();
    const next = vi.fn();

    await changeMyPassword(req, res, next);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects a weak new password", async () => {
    const req = {
      body: { currentPassword: "whatever", newPassword: "short" },
      user: { id: 1, role: "Parent" },
    };
    const res = mockRes();
    const next = vi.fn();

    await changeMyPassword(req, res, next);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("rejects an incorrect current password", async () => {
    const passwordHash = await bcrypt.hash("correct-horse-1", 10);
    prisma.user.findUnique.mockResolvedValue({ id: 1, passwordHash, tokenVersion: 0 });
    mockValidOtp();

    const req = {
      body: { currentPassword: "wrong-password", newPassword: "brand-new-pass-1", otpCode: VALID_OTP },
      user: { id: 1, role: "Parent" },
    };
    const res = mockRes();
    const next = vi.fn();

    await changeMyPassword(req, res, next);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("updates the password, bumps tokenVersion, and returns a fresh token", async () => {
    const passwordHash = await bcrypt.hash("correct-horse-1", 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 1,
      email: "user@example.com",
      role: "Parent",
      passwordHash,
      tokenVersion: 0,
    });
    prisma.user.update.mockResolvedValue({
      id: 1,
      email: "user@example.com",
      role: "Parent",
      tokenVersion: 1,
    });
    mockValidOtp();

    const req = {
      body: { currentPassword: "correct-horse-1", newPassword: "brand-new-pass-1", otpCode: VALID_OTP },
      user: { id: 1, role: "Parent" },
    };
    const res = mockRes();
    const next = vi.fn();

    await changeMyPassword(req, res, next);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({ tokenVersion: { increment: 1 } }),
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ token: expect.any(String) }),
    );
  });
});

describe("uploadMyProfilePhoto", () => {
  it("rejects when no file was uploaded", async () => {
    const req = { file: undefined, user: { id: 1, role: "Parent" }, protocol: "https", get: () => "host" };
    const res = mockRes();
    const next = vi.fn();

    await uploadMyProfilePhoto(req, res, next);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("stores the uploaded file and returns a signed URL", async () => {
    prisma.user.update.mockResolvedValue({
      id: 1,
      profilePicture: "https://host/api/files/abc123.jpg",
    });

    const req = {
      file: { filename: "abc123.jpg" },
      user: { id: 1, role: "Parent" },
      protocol: "https",
      get: () => "host",
    };
    const res = mockRes();
    const next = vi.fn();

    await uploadMyProfilePhoto(req, res, next);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: { profilePicture: "https://host/api/files/abc123.jpg" },
      }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        profilePicture: expect.stringContaining("https://host/api/files/abc123.jpg"),
      }),
    );
  });
});
