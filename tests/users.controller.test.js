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
      updateMany: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    parentChild: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      // Teacher scope checks (own links / other links); 0 = an unlinked account.
      count: vi.fn().mockResolvedValue(0),
      // Is the account connected to any student? (default: yes)
      findFirst: vi.fn().mockResolvedValue({ id: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    center: {
      findUnique: vi.fn().mockResolvedValue({ id: 3 }),
    },
    student: {
      findMany: vi.fn(),
      count: vi.fn(),
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
const { hashOtp } = await import("../src/utils/otp.js");

// changeMyPassword/deleteMyAccount now require a verified OTP before doing
// anything else; stub a matching, unexpired, unused-attempt record so
// tests written before that requirement can still exercise the rest of
// each function's behavior.
function mockValidOtp() {
  prisma.accountActionOtp.findFirst.mockResolvedValue({
    id: 1,
    otpCode: hashOtp(VALID_OTP),
    expiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
  });
  // 1st updateMany claims the attempt, 2nd consumes the code; both succeed.
  prisma.accountActionOtp.updateMany.mockResolvedValue({ count: 1 });
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

  describe("Teacher scope (by center)", () => {
    const teacher = { id: 9, role: "Teacher", centerId: 3 };

    it("lists only the Teachers and Parent/Guardian accounts of the Teacher's own center, never Admins", async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.student.findMany.mockResolvedValue([]);

      await listUsers({ user: teacher }, mockRes(), vi.fn());

      expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
        role: { in: ["Teacher", "Parent", "Guardian"] },
        centerId: 3,
      });
    });

    it("refuses, with a clear message, a Teacher who has no center yet (null would match every unassigned account)", async () => {
      const next = vi.fn();

      await listUsers({ user: { id: 9, role: "Teacher", centerId: null } }, mockRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403, message: expect.stringMatching(/assigned to a center/) }));
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it("shows a Teacher only their center's students in each account's studentIds", async () => {
      prisma.user.findMany.mockResolvedValue([
        { id: 5, role: "Parent", name: "Maria", children: [{ studentId: 1 }, { studentId: 2 }, { studentId: 3 }] },
      ]);
      prisma.student.findMany.mockResolvedValue([{ id: 1 }, { id: 3 }]);
      const res = mockRes();

      await listUsers({ user: teacher }, res, vi.fn());

      expect(prisma.student.findMany).toHaveBeenCalledWith({ where: { teacher: { centerId: 3 } }, select: { id: true } });
      expect(res.json.mock.calls[0][0][0].studentIds).toEqual([1, 3]);
    });

    it("returns the center, and its name under the old centerLocation field", async () => {
      prisma.user.findMany.mockResolvedValue([
        { id: 5, role: "Parent", name: "Maria", centerId: 3, center: { id: 3, name: "ECCD Angeles" }, children: [] },
      ]);
      prisma.student.findMany.mockResolvedValue([]);
      const res = mockRes();

      await listUsers({ user: teacher }, res, vi.fn());

      expect(res.json.mock.calls[0][0][0]).toMatchObject({ centerId: 3, centerLocation: "ECCD Angeles" });
    });

    it("gives an Admin every account with every link, and no scope queries", async () => {
      prisma.user.findMany.mockResolvedValue([
        { id: 5, role: "Parent", name: "Maria", children: [{ studentId: 1 }, { studentId: 2 }] },
      ]);
      const res = mockRes();

      await listUsers({ user: { id: 1, role: "Admin" } }, res, vi.fn());

      expect(prisma.user.findMany.mock.calls[0][0].where).toBeUndefined();
      expect(prisma.student.findMany).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0][0].studentIds).toEqual([1, 2]);
    });
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
    centerId: 3,
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

  it("rejects a Teacher creating a Teacher account, before anything is written", async () => {
    const res = mockRes();
    await registerUser({ body: { ...baseBody, role: "Teacher" }, user: { id: 1, role: "Teacher", centerId: 3 } }, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: "Only an Admin can create a Teacher account" });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it.each(["Parent", "Guardian"])("still lets a Teacher create a %s account", async (role) => {
    prisma.user.create.mockResolvedValue({ id: 2, role });
    prisma.user.findUnique.mockResolvedValue({ id: 2, role, children: [] });
    prisma.student.findMany.mockResolvedValue([]);
    const res = mockRes();
    await registerUser(
      { body: { ...baseBody, role, phone: "09171234567" }, user: { id: 1, role: "Teacher", centerId: 3 } },
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("rejects a non-Admin trying to grant the Admin role", async () => {
    const req = {
      body: { ...baseBody, role: "Admin" },
      user: { id: 1, role: "Teacher", centerId: 3 },
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

    const req = { body: { userId: 5, firstName: "Changed" }, user: { id: 1, role: "Teacher", centerId: 3 } };
    const res = mockRes();
    const next = vi.fn();

    await updateUser(req, res, next);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("blocks a non-Admin from promoting an account to Admin", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: "Teacher", firstName: "A", lastName: "B" });

    const req = { body: { userId: 5, role: "Admin" }, user: { id: 1, role: "Teacher", centerId: 3 } };
    const res = mockRes();
    const next = vi.fn();

    await updateUser(req, res, next);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("allows a Teacher to edit a parent/guardian account", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 5,
      centerId: 3,
      role: "Parent",
      firstName: "Old",
      middleName: null,
      lastName: "Name",
    });
    prisma.user.update.mockResolvedValue({ id: 5, firstName: "New", lastName: "Name", role: "Parent" });

    const req = {
      body: { userId: 5, firstName: "New", lastName: "Name" },
      user: { id: 1, role: "Teacher", centerId: 3 },
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

  describe("who may change an email or a role (M40)", () => {
    const teacher = { id: 1, role: "Teacher", centerId: 3 };
    const admin = { id: 2, role: "Admin" };
    const existingParent = { id: 5, centerId: 3, role: "Parent", email: "maria@example.com", firstName: "M", lastName: "C", middleName: null };

    const run = async (body, user) => {
      const res = mockRes();
      const next = vi.fn();
      await updateUser({ body: { userId: 5, ...body }, user }, res, next);
      return { res, next };
    };

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValueOnce(existingParent).mockResolvedValue({ id: 5, children: [] });
      prisma.user.update.mockResolvedValue({ id: 5 });
      prisma.student.findMany.mockResolvedValue([]);
    });

    it("blocks a Teacher from changing another account's email, and writes nothing", async () => {
      const { res } = await run({ email: "attacker@example.com" }, teacher);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ message: expect.stringMatching(/Only an Admin can change an account's email/) });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("blocks a Teacher from changing their own email here too (Settings asks for their password)", async () => {
      prisma.user.findUnique.mockReset();
      prisma.user.findUnique.mockResolvedValueOnce({ id: 1, role: "Teacher", email: "t@example.com" });
      const { res } = await run({ userId: 1, email: "new@example.com" }, teacher);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("allows the edit form to resend the unchanged email (any casing)", async () => {
      const { res, next } = await run({ email: "Maria@Example.com", firstName: "Maria" }, teacher);
      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledOnce();
    });

    it("allows an Admin to change an email", async () => {
      await run({ email: "new@example.com" }, admin);
      expect(prisma.user.update.mock.calls[0][0].data.email).toBe("new@example.com");
    });

    it("blocks a Teacher from moving a Parent to Teacher, and writes nothing", async () => {
      const { res } = await run({ role: "Teacher" }, teacher);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ message: "Only an Admin can change an account's role" });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("allows a Teacher to resend the role the account already has", async () => {
      const { res } = await run({ role: "Parent", firstName: "Maria" }, teacher);
      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(prisma.user.update).toHaveBeenCalledOnce();
    });

    it("allows an Admin to change a role", async () => {
      await run({ role: "Guardian" }, admin);
      expect(prisma.user.update.mock.calls[0][0].data.role).toBe("Guardian");
    });
  });

  it("blocks a Teacher from editing another Teacher account", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: "Teacher" });

    const req = { body: { userId: 5, firstName: "Changed" }, user: { id: 1, role: "Teacher", centerId: 3 } };
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

    const req = { params: { id: "5" }, user: { id: 1, role: "Teacher", centerId: 3 } };
    const res = mockRes();
    const next = vi.fn();

    await deleteUser(req, res, next);

    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("deletes a parent/guardian account", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, centerId: 3, role: "Parent" });
    prisma.user.delete.mockResolvedValue({});

    const req = { params: { id: "5" }, user: { id: 1, role: "Teacher", centerId: 3 } };
    const res = mockRes();
    const next = vi.fn();

    await deleteUser(req, res, next);

    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 5 } });
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("blocks a Teacher from deleting another Teacher account", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: "Teacher" });

    const req = { params: { id: "5" }, user: { id: 1, role: "Teacher", centerId: 3 } };
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

describe("deleteMyAccount — OTP handling and Teacher guard", () => {
  const req = (role = "Parent") => ({
    body: { password: "correct-horse-1", otpCode: VALID_OTP },
    user: { id: 1, role },
  });

  it("does not consume the code when the password is wrong (so one typo doesn't force a new code)", async () => {
    const passwordHash = await bcrypt.hash("some-other-pass-1", 10);
    prisma.user.findUnique.mockResolvedValue({ id: 1, role: "Parent", passwordHash });
    mockValidOtp();
    const res = mockRes();

    await deleteMyAccount(req(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    // Only the attempt claim ran; nothing flipped isUsed.
    const calls = prisma.accountActionOtp.updateMany.mock.calls.map((c) => c[0].data);
    expect(calls).toEqual([{ attempts: { increment: 1 } }]);
  });

  it("consumes the code only after every check has passed", async () => {
    const passwordHash = await bcrypt.hash("correct-horse-1", 10);
    prisma.user.findUnique.mockResolvedValue({ id: 1, role: "Parent", passwordHash });
    prisma.user.delete.mockResolvedValue({});
    mockValidOtp();

    await deleteMyAccount(req(), mockRes(), vi.fn());

    const calls = prisma.accountActionOtp.updateMany.mock.calls.map((c) => c[0].data);
    expect(calls).toEqual([{ attempts: { increment: 1 } }, { isUsed: true }]);
  });

  it("refuses to delete a Teacher who still has students, and keeps the code usable", async () => {
    const passwordHash = await bcrypt.hash("correct-horse-1", 10);
    prisma.user.findUnique.mockResolvedValue({ id: 1, role: "Teacher", passwordHash });
    prisma.student.count.mockResolvedValue(3);
    mockValidOtp();
    const res = mockRes();

    await deleteMyAccount(req("Teacher"), res, vi.fn());

    expect(prisma.student.count).toHaveBeenCalledWith({ where: { teacherId: 1 } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.user.delete).not.toHaveBeenCalled();
    const calls = prisma.accountActionOtp.updateMany.mock.calls.map((c) => c[0].data);
    expect(calls).not.toContainEqual({ isUsed: true });
  });

  it("deletes a Teacher with no students", async () => {
    const passwordHash = await bcrypt.hash("correct-horse-1", 10);
    prisma.user.findUnique.mockResolvedValue({ id: 1, role: "Teacher", passwordHash });
    prisma.student.count.mockResolvedValue(0);
    prisma.user.delete.mockResolvedValue({});
    mockValidOtp();
    const res = mockRes();

    await deleteMyAccount(req("Teacher"), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("rejects when parallel requests already used the attempts (claim matches no row)", async () => {
    prisma.accountActionOtp.findFirst.mockResolvedValue({
      id: 1, otpCode: VALID_OTP, expiresAt: new Date(Date.now() + 60_000), attempts: 0,
    });
    prisma.accountActionOtp.updateMany.mockResolvedValue({ count: 0 });
    const res = mockRes();

    await deleteMyAccount(req(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.user.delete).not.toHaveBeenCalled();
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

describe("parent/guardian <-> student linking", () => {
  const linkBody = {
    firstName: "Maria",
    lastName: "Dela Cruz",
    email: "Maria@Example.com",
    password: "correct-horse-1",
    role: "Parent",
    centerId: 3,
  };
  const admin = { id: 1, role: "Admin" };

  function stubRegister() {
    prisma.user.create.mockResolvedValue({ id: 9 });
    prisma.user.findUnique.mockResolvedValue({ id: 9, children: [] });
  }

  it("links a new Parent account to students that already list its email", async () => {
    stubRegister();
    prisma.student.findMany.mockResolvedValue([{ id: 3 }, { id: 4 }]);

    await registerUser({ body: { ...linkBody }, user: admin }, mockRes(), vi.fn());

    expect(prisma.student.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { motherEmail: "maria@example.com" },
          { fatherEmail: "maria@example.com" },
          { guardianEmail: "maria@example.com" },
        ],
        // only students whose Teacher is at the account's center
        teacher: { centerId: 3 },
      },
      select: { id: true },
    });
    expect(prisma.parentChild.createMany).toHaveBeenCalledWith({
      data: [
        { parentId: 9, studentId: 3 },
        { parentId: 9, studentId: 4 },
      ],
      skipDuplicates: true,
    });
  });

  it("does not look up students for a Teacher account", async () => {
    stubRegister();

    await registerUser({ body: { ...linkBody, role: "Teacher" }, user: admin }, mockRes(), vi.fn());

    expect(prisma.student.findMany).not.toHaveBeenCalled();
    expect(prisma.parentChild.createMany).not.toHaveBeenCalled();
  });

  it("returns 400 when a selected student does not exist", async () => {
    prisma.student.findMany.mockResolvedValue([]);

    const next = vi.fn();
    await registerUser({ body: { ...linkBody, studentIds: [999] }, user: admin }, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400, message: expect.stringMatching(/no longer exist/) }));
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("returns 400 when a student is deleted between the check and the save", async () => {
    prisma.user.create.mockResolvedValue({ id: 9 });
    prisma.student.findMany.mockResolvedValue([{ id: 999, name: "Kai", teacher: { centerId: 3 } }]);
    prisma.parentChild.createMany.mockRejectedValue(Object.assign(new Error("fk"), { code: "P2003" }));

    const res = mockRes();
    const next = vi.fn();
    await registerUser({ body: { ...linkBody, studentIds: [999] }, user: admin }, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("keeps several selected students when an account is saved (replace semantics)", async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({ id: 5, centerId: 3, role: "Parent", email: "maria@example.com" })
      .mockResolvedValue({ id: 5, children: [] });
    prisma.user.update.mockResolvedValue({ id: 5 });
    prisma.student.findMany.mockResolvedValue(
      [1, 2, 3].map((id) => ({ id, name: `Student ${id}`, teacher: { centerId: 3 } })),
    );

    await updateUser(
      { body: { userId: 5, studentIds: [1, 2, 3, 3] }, user: admin },
      mockRes(),
      vi.fn(),
    );

    expect(prisma.parentChild.deleteMany).toHaveBeenCalledWith({ where: { parentId: 5 } });
    expect(prisma.parentChild.createMany).toHaveBeenCalledWith({
      data: [
        { parentId: 5, studentId: 1 },
        { parentId: 5, studentId: 2 },
        { parentId: 5, studentId: 3 },
      ],
      skipDuplicates: true,
    });
  });

  it("does not re-match students on an edit that leaves email and role alone", async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({ id: 5, centerId: 3, role: "Parent", email: "maria@example.com" })
      .mockResolvedValue({ id: 5, children: [] });
    prisma.user.update.mockResolvedValue({ id: 5 });

    await updateUser(
      { body: { userId: 5, phone: "09171234567", email: "maria@example.com" }, user: admin },
      mockRes(),
      vi.fn(),
    );

    expect(prisma.student.findMany).not.toHaveBeenCalled();
  });

  it("matches students when a Parent's email changes", async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({ id: 5, centerId: 3, role: "Parent", email: "old@example.com" })
      .mockResolvedValue({ id: 5, children: [] });
    prisma.user.update.mockResolvedValue({ id: 5 });
    prisma.student.findMany.mockResolvedValue([{ id: 3 }]);

    await updateUser(
      { body: { userId: 5, email: "New@Example.com" }, user: admin },
      mockRes(),
      vi.fn(),
    );

    expect(prisma.student.findMany.mock.calls[0][0].where.OR[0]).toEqual({ motherEmail: "new@example.com" });
    expect(prisma.parentChild.createMany).toHaveBeenCalledWith({
      data: [{ parentId: 5, studentId: 3 }],
      skipDuplicates: true,
    });
  });

  it("matches students when an account becomes a Guardian", async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({ id: 5, centerId: 3, role: "Teacher", email: "g@example.com" })
      .mockResolvedValue({ id: 5, children: [] });
    prisma.user.update.mockResolvedValue({ id: 5 });
    prisma.student.findMany.mockResolvedValue([{ id: 3 }]);

    await updateUser({ body: { userId: 5, role: "Guardian" }, user: admin }, mockRes(), vi.fn());

    expect(prisma.parentChild.createMany).toHaveBeenCalled();
  });

  it("removes student links when a Parent is changed to Teacher", async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({ id: 5, centerId: 3, role: "Parent", email: "maria@example.com" })
      .mockResolvedValue({ id: 5, children: [] });
    prisma.user.update.mockResolvedValue({ id: 5 });

    await updateUser({ body: { userId: 5, role: "Teacher" }, user: admin }, mockRes(), vi.fn());

    expect(prisma.parentChild.deleteMany).toHaveBeenCalledWith({ where: { parentId: 5 } });
    expect(prisma.student.findMany).not.toHaveBeenCalled();
  });

  it("refuses to connect students to a non-Parent/Guardian role", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: "Teacher", email: "t@example.com" });

    const res = mockRes();
    await updateUser({ body: { userId: 5, studentIds: [1] }, user: admin }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.parentChild.createMany).not.toHaveBeenCalled();
  });

  it("never matches students from a self-service email change", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, email: "old@example.com", passwordHash: "x" });
    prisma.user.update.mockResolvedValue({ id: 5 });

    await updateMyProfile(
      { body: { phone: "09171234567" }, user: { id: 5, role: "Parent" } },
      mockRes(),
      vi.fn(),
    );

    expect(prisma.student.findMany).not.toHaveBeenCalled();
  });
});

describe("studentIds validation", () => {
  const baseBody = {
    firstName: "Maria",
    lastName: "Santos",
    email: "maria@example.com",
    password: "correct-horse-1",
    role: "Parent",
    phone: "09171234567",
    centerId: 3,
  };
  const admin = { id: 1, role: "Admin" };

  it.each([[[true]], [[0]], [[-1]], [[1.5]], [["2"]], [[null]]])(
    "registerUser rejects non-strict ids %j without touching the database",
    async (studentIds) => {
      const next = vi.fn();
      await registerUser({ body: { ...baseBody, studentIds }, user: admin }, mockRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
      expect(prisma.user.create).not.toHaveBeenCalled();
    },
  );

  it("registerUser rejects more than 100 ids", async () => {
    const next = vi.fn();
    const studentIds = Array.from({ length: 101 }, (_, i) => i + 1);
    await registerUser({ body: { ...baseBody, studentIds }, user: admin }, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("updateUser rejects non-strict ids and oversized lists before any write", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, centerId: 3, role: "Parent", email: "maria@example.com" });

    for (const studentIds of [[true], [0], [-3], [2.5], Array.from({ length: 101 }, (_, i) => i + 1)]) {
      const next = vi.fn();
      await updateUser({ body: { userId: 5, studentIds }, user: admin }, mockRes(), next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    }
    expect(prisma.parentChild.deleteMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("Teacher scope over Parent/Guardian accounts (by center)", () => {
  const teacher = { id: 7, role: "Teacher", centerId: 3 };
  const admin = { id: 1, role: "Admin" };
  const parent = { id: 5, role: "Parent", centerId: 3, email: "maria@example.com", firstName: "Maria", lastName: "Santos" };

  // teacherAccountScope asks twice: links to the Teacher's students, then to anyone else's.
  const links = (own, other) => prisma.parentChild.count.mockResolvedValueOnce(own).mockResolvedValueOnce(other);

  describe("updateUser", () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue(parent);
      prisma.user.update.mockResolvedValue({ id: 5 });
    });

    it("answers 'not found' for an account at another center, and writes nothing", async () => {
      prisma.user.findUnique.mockResolvedValue({ ...parent, centerId: 4 });
      const res = mockRes();

      await updateUser({ body: { userId: 5, firstName: "X" }, user: teacher }, res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ message: "This account could not be found in your center." });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.parentChild.deleteMany).not.toHaveBeenCalled();
    });

    it("answers 'not found' for an account with no center, not 'allowed' (null must not match null)", async () => {
      prisma.user.findUnique.mockResolvedValue({ ...parent, centerId: null });
      const res = mockRes();

      await updateUser({ body: { userId: 5, firstName: "X" }, user: teacher }, res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(404);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("lets any Teacher of the same center edit the account, whoever their students are", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(parent).mockResolvedValue({ id: 5, children: [] });

      await updateUser({ body: { userId: 5, firstName: "Mia" }, user: teacher }, mockRes(), vi.fn());

      expect(prisma.user.update).toHaveBeenCalled();
      expect(prisma.parentChild.count).not.toHaveBeenCalled();
    });

    it("refuses a Teacher without a center", async () => {
      const next = vi.fn();

      await updateUser({ body: { userId: 5, firstName: "X" }, user: { ...teacher, centerId: null } }, mockRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("does not apply to an Admin", async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ ...parent, centerId: 4 }).mockResolvedValue({ id: 5, children: [] });

      await updateUser({ body: { userId: 5, firstName: "Mia" }, user: admin }, mockRes(), vi.fn());

      expect(prisma.user.update).toHaveBeenCalled();
    });

    it("refuses studentIds that are not the Teacher's own, and writes nothing", async () => {
      prisma.student.count.mockResolvedValue(1); // only 1 of the 2 ids is theirs
      const next = vi.fn();

      await updateUser({ body: { userId: 5, studentIds: [1, 2] }, user: teacher }, mockRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.parentChild.deleteMany).not.toHaveBeenCalled();
    });

    it("replaces only the links to the Teacher's center, leaving other centers' links alone", async () => {
      prisma.student.count.mockResolvedValue(2);
      prisma.user.findUnique.mockResolvedValueOnce(parent).mockResolvedValue({ id: 5, children: [] });

      await updateUser({ body: { userId: 5, studentIds: [1, 2] }, user: teacher }, mockRes(), vi.fn());

      expect(prisma.parentChild.deleteMany).toHaveBeenCalledWith({
        where: { parentId: 5, student: { teacher: { centerId: 3 } } },
      });
      expect(prisma.parentChild.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: [{ parentId: 5, studentId: 1 }, { parentId: 5, studentId: 2 }] }),
      );
    });

    it("reactivates the account when it is given a child again", async () => {
      prisma.student.count.mockResolvedValue(1);
      prisma.user.findUnique.mockResolvedValueOnce(parent).mockResolvedValue({ id: 5, children: [] });

      prisma.parentChild.createMany.mockResolvedValue({ count: 1 }); // an earlier test leaves it rejecting
      await updateUser({ body: { userId: 5, studentIds: [1] }, user: teacher }, mockRes(), vi.fn());

      expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: 5, isActive: false }, data: { isActive: true } });
    });

    it("lets an Admin replace the whole list, with students from the account's center", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(parent).mockResolvedValue({ id: 5, children: [] });
      prisma.student.findMany.mockResolvedValue([{ id: 1, name: "Kai", teacher: { centerId: 3 } }]);

      await updateUser({ body: { userId: 5, studentIds: [1] }, user: admin }, mockRes(), vi.fn());

      expect(prisma.parentChild.deleteMany).toHaveBeenCalledWith({ where: { parentId: 5 } });
    });

    it("returns only the Teacher's own students in the saved account", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(parent)
        .mockResolvedValue({ id: 5, children: [{ studentId: 1 }, { studentId: 9 }] });
      prisma.student.findMany.mockResolvedValue([{ id: 1 }]);
      const res = mockRes();

      await updateUser({ body: { userId: 5, firstName: "Mia" }, user: teacher }, res, vi.fn());

      expect(res.json.mock.calls[0][0].studentIds).toEqual([1]);
    });
  });

  describe("deleteUser", () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue(parent);
      prisma.user.delete.mockResolvedValue({});
    });

    it("answers 'not found' for an account at another center", async () => {
      prisma.user.findUnique.mockResolvedValue({ ...parent, centerId: 4 });
      const res = mockRes();

      await deleteUser({ params: { id: "5" }, user: teacher }, res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(404);
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it("refuses, saying why, when the account also reaches another Teacher's student", async () => {
      links(1, 1);
      const res = mockRes();

      await deleteUser({ params: { id: "5" }, user: teacher }, res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ message: expect.stringMatching(/only an Admin can delete/) });
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it("allows an account connected only to the Teacher's own students", async () => {
      links(2, 0);
      const res = mockRes();

      await deleteUser({ params: { id: "5" }, user: teacher }, res, vi.fn());

      expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 5 } });
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it("lets an Admin delete any account without scope queries", async () => {
      prisma.user.findUnique.mockResolvedValue({ ...parent, centerId: 4 });

      await deleteUser({ params: { id: "5" }, user: admin }, mockRes(), vi.fn());

      expect(prisma.parentChild.count).not.toHaveBeenCalled();
      expect(prisma.user.delete).toHaveBeenCalled();
    });
  });

  describe("registerUser", () => {
    const body = {
      firstName: "Maria", lastName: "Santos", email: "maria@example.com",
      password: "correct-horse-1", role: "Parent", phone: "09171234567",
    };

    beforeEach(() => {
      prisma.user.create.mockReset().mockResolvedValue({ id: 9 });
      prisma.parentChild.createMany.mockReset().mockResolvedValue({ count: 1 });
      prisma.student.findMany.mockResolvedValue([]);
      prisma.user.findUnique.mockResolvedValue({ id: 9, children: [{ studentId: 4 }] });
    });

    it("always creates the account at the Teacher's own center, ignoring a centerId in the request", async () => {
      prisma.student.count.mockResolvedValue(1);

      await registerUser({ body: { ...body, studentIds: [4], centerId: 99 }, user: teacher }, mockRes(), vi.fn());

      expect(prisma.user.create.mock.calls[0][0].data.centerId).toBe(3);
      expect(prisma.center.findUnique).not.toHaveBeenCalled();
    });

    it("refuses a Teacher who has no center, and creates nothing", async () => {
      const next = vi.fn();

      await registerUser({ body: { ...body, studentIds: [4] }, user: { ...teacher, centerId: null } }, mockRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("refuses to connect a new account to students that are not the Teacher's own", async () => {
      prisma.student.count.mockResolvedValue(0);
      const next = vi.fn();

      await registerUser({ body: { ...body, studentIds: [4] }, user: teacher }, mockRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("connects a new account to the Teacher's own students", async () => {
      prisma.student.count.mockResolvedValue(1);
      const res = mockRes();

      await registerUser({ body: { ...body, studentIds: [4] }, user: teacher }, res, vi.fn());

      expect(prisma.parentChild.createMany).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });
});

describe("a Parent/Guardian must be connected to a student", () => {
  const admin = { id: 1, role: "Admin" };
  const body = {
    firstName: "Maria", lastName: "Santos", email: "maria@example.com",
    password: "correct-horse-1", role: "Parent", phone: "09171234567", centerId: 3,
  };

  beforeEach(() => {
    prisma.user.create.mockReset().mockResolvedValue({ id: 9 });
    prisma.parentChild.createMany.mockReset().mockResolvedValue({ count: 1 });
    prisma.student.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({ id: 9, children: [] });
  });

  it("rejects a new Parent with no students and no email match, and the save is rolled back", async () => {
    prisma.parentChild.findFirst.mockResolvedValueOnce(null);
    const next = vi.fn();

    await registerUser({ body, user: admin }, mockRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400, message: expect.stringMatching(/connected to at least one student/) }),
    );
    // thrown inside the transaction callback, so Prisma rolls the create back
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("accepts a new Parent whose email matches a student at the same center", async () => {
    prisma.student.findMany.mockResolvedValue([{ id: 3 }]);
    prisma.parentChild.findFirst.mockResolvedValueOnce({ id: 1 });
    const res = mockRes();

    await registerUser({ body, user: admin }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("does not ask a Teacher or Admin account for a student", async () => {
    const res = mockRes();

    await registerUser({ body: { ...body, role: "Teacher" }, user: admin }, res, vi.fn());

    expect(prisma.parentChild.findFirst).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("rejects saving an existing Parent so that it ends with no students", async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 5, centerId: 3, role: "Parent", email: "maria@example.com" });
    prisma.user.update.mockResolvedValue({ id: 5 });
    prisma.parentChild.findFirst.mockResolvedValueOnce(null);
    const next = vi.fn();

    await updateUser({ body: { userId: 5, studentIds: [] }, user: admin }, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400, message: expect.stringMatching(/at least one student/) }));
  });

  it("requires a student when an account becomes a Parent", async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 5, centerId: 3, role: "Teacher", email: "t@example.com" });
    prisma.user.update.mockResolvedValue({ id: 5 });
    prisma.parentChild.findFirst.mockResolvedValueOnce(null);
    const next = vi.fn();

    await updateUser({ body: { userId: 5, role: "Parent" }, user: admin }, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});

describe("account centers", () => {
  const admin = { id: 1, role: "Admin" };
  const body = {
    firstName: "Maria", lastName: "Santos", email: "maria@example.com",
    password: "correct-horse-1", role: "Parent", phone: "09171234567",
  };

  beforeEach(() => {
    prisma.user.create.mockReset().mockResolvedValue({ id: 9 });
    prisma.student.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({ id: 9, children: [] });
    prisma.center.findUnique.mockResolvedValue({ id: 3 });
  });

  it("requires an Admin to choose a center for a new Parent, Guardian or Teacher", async () => {
    const next = vi.fn();

    await registerUser({ body, user: admin }, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400, message: "Choose the center for this account." }));
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("rejects a center that does not exist", async () => {
    prisma.center.findUnique.mockResolvedValue(null);
    const next = vi.fn();

    await registerUser({ body: { ...body, centerId: 77 }, user: admin }, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400, message: expect.stringMatching(/no longer exists/) }));
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("rejects students from another center when an Admin connects them", async () => {
    prisma.student.findMany.mockResolvedValue([
      { id: 1, name: "Kai Moran", teacher: { centerId: 3 } },
      { id: 2, name: "Ana Cruz", teacher: { centerId: 4 } },
      { id: 3, name: "Lu Reyes", teacher: null },
    ]);
    const next = vi.fn();

    await registerUser({ body: { ...body, centerId: 3, studentIds: [1, 2, 3] }, user: admin }, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400, message: expect.stringMatching(/Ana Cruz, Lu Reyes/) }));
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("only an Admin can move an account to another center", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, centerId: 3, role: "Parent", email: "maria@example.com" });
    const res = mockRes();

    await updateUser({ body: { userId: 5, centerId: 4 }, user: { id: 7, role: "Teacher", centerId: 3 } }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: "Only an Admin can change an account's center" });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("lets the edit form resend the unchanged center", async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 5, centerId: 3, role: "Parent", email: "maria@example.com" }).mockResolvedValue({ id: 5, children: [] });
    prisma.user.update.mockResolvedValue({ id: 5 });
    const res = mockRes();

    await updateUser({ body: { userId: 5, centerId: 3, firstName: "Maria" }, user: { id: 7, role: "Teacher", centerId: 3 } }, res, vi.fn());

    expect(prisma.user.update).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it("re-matches students by email when an Admin moves an account to another center, and checks every link", async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 5, centerId: 3, role: "Parent", email: "maria@example.com" }).mockResolvedValue({ id: 5, children: [] });
    prisma.user.update.mockResolvedValue({ id: 5 });
    prisma.center.findUnique.mockResolvedValue({ id: 4 });
    prisma.student.findMany.mockResolvedValue([{ id: 8 }]);
    prisma.parentChild.findMany.mockResolvedValue([{ student: { name: "Old Kid", teacher: { centerId: 3 } } }]);
    const next = vi.fn();

    await updateUser({ body: { userId: 5, centerId: 4 }, user: admin }, mockRes(), next);

    expect(prisma.student.findMany.mock.calls[0][0].where.teacher).toEqual({ centerId: 4 });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400, message: expect.stringMatching(/Old Kid/) }));
  });

  it("will not leave a Teacher, Parent or Guardian without a center", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 5, centerId: null, role: "Parent", email: "maria@example.com" });
    const res = mockRes();

    await updateUser({ body: { userId: 5, firstName: "Maria" }, user: admin }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "Choose a center for this account." });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("account form messages", () => {
  const admin = { id: 1, role: "Admin" };
  const body = { firstName: "Maria", lastName: "Santos", email: "maria@example.com", password: "correct-horse-1", role: "Teacher", centerId: 3 };
  const messageFor = async (patch) => {
    const next = vi.fn();
    await registerUser({ body: { ...body, ...patch }, user: admin }, mockRes(), next);
    return next.mock.calls[0]?.[0]?.message;
  };

  it("says which name is missing, without field names like firstName", async () => {
    expect(await messageFor({ firstName: "  " })).toBe("First name is required (up to 100 characters).");
    expect(await messageFor({ lastName: "" })).toBe("Last name is required (up to 100 characters).");
  });

  it("explains a bad email and a bad Parent phone", async () => {
    expect(await messageFor({ email: "nope" })).toBe("Enter a valid email address, for example name@example.com.");
    expect(await messageFor({ role: "Parent", phone: "123", studentIds: [] })).toBe(
      "Enter a Philippine mobile number, for example 09171234567.",
    );
  });

  it("explains a bad role", async () => {
    expect(await messageFor({ role: "Janitor" })).toMatch(/^Choose a role: /);
  });

  it("explains a bad student list", async () => {
    expect(await messageFor({ role: "Parent", phone: "09171234567", studentIds: [0] })).toMatch(/not valid. Reload the page/);
  });
});

describe("moving a Teacher to another center", () => {
  const admin = { id: 1, role: "Admin" };
  const existingTeacher = { id: 5, role: "Teacher", centerId: 3, email: "t@example.com" };

  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValueOnce(existingTeacher).mockResolvedValue({ id: 5, children: [] });
    prisma.user.update.mockResolvedValue({ id: 5 });
    prisma.center.findUnique.mockResolvedValue({ id: 4 });
    prisma.user.count.mockReset();
  });

  it("is refused while Parent/Guardian accounts of the old center are connected to the Teacher's students", async () => {
    prisma.user.count.mockResolvedValue(3);
    const next = vi.fn();

    await updateUser({ body: { userId: 5, centerId: 4 }, user: admin }, mockRes(), next);

    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        role: { in: ["Parent", "Guardian"] },
        OR: [{ centerId: null }, { centerId: { not: 4 } }],
        children: { some: { student: { teacherId: 5 } } },
      },
    });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400, message: expect.stringMatching(/3 parent\/guardian accounts are connected to this Teacher's students/) }),
    );
  });

  it("goes through when no account would be left behind", async () => {
    prisma.user.count.mockResolvedValue(0);
    const next = vi.fn();
    const res = mockRes();

    await updateUser({ body: { userId: 5, centerId: 4 }, user: admin }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.user.update.mock.calls[0][0].data.centerId).toBe(4);
  });

  it("is not checked when the center stays the same", async () => {
    await updateUser({ body: { userId: 5, centerId: 3, firstName: "T" }, user: admin }, mockRes(), vi.fn());

    expect(prisma.user.count).not.toHaveBeenCalled();
  });
});
