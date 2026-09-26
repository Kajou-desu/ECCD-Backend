import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    student: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
    },
    user: { findMany: vi.fn() },
    parentChild: { createMany: vi.fn() },
    // Controllers run inside prisma.$transaction((tx) => ...); passing the
    // mocked prisma as `tx` keeps every assertion below working unchanged.
    $transaction: vi.fn((callback) => callback(prisma)),
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { createStudent, updateStudent, importStudents } = await import(
  "../src/controllers/students.controller.js"
);

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation((callback) => callback(prisma));
});

describe("student gender handling", () => {
  it("stores the selected gender when creating a student", async () => {
    prisma.student.create.mockResolvedValue({
      id: 42,
      firstName: "Ari",
      lastName: "Bell",
      middleName: null,
      suffix: null,
      name: "Ari Bell",
      birthday: new Date("2024-01-02T00:00:00.000Z"),
      address: "Sample street",
      session: "morning",
      status: "active",
      motherName: "Sample Mother",
      motherAddress: null,
      motherPhone: null,
      motherEmail: null,
      fatherName: null,
      fatherAddress: null,
      fatherPhone: null,
      fatherEmail: null,
      guardianName: null,
      guardianAddress: null,
      guardianPhone: null,
      guardianEmail: null,
      gender: "female",
      allergies: null,
      dietary: null,
      specialNotes: null,
      photo: null,
      documents: [],
    });
    prisma.student.update.mockResolvedValue({
      id: 42,
      studentCode: "ECCD-2026-42",
      firstName: "Ari",
      lastName: "Bell",
      middleName: null,
      suffix: null,
      name: "Ari Bell",
      birthday: new Date("2024-01-02T00:00:00.000Z"),
      address: "Sample street",
      session: "morning",
      status: "active",
      motherName: "Sample Mother",
      motherAddress: null,
      motherPhone: null,
      motherEmail: null,
      fatherName: null,
      fatherAddress: null,
      fatherPhone: null,
      fatherEmail: null,
      guardianName: null,
      guardianAddress: null,
      guardianPhone: null,
      guardianEmail: null,
      gender: "female",
      allergies: null,
      dietary: null,
      specialNotes: null,
      photo: null,
      documents: [],
    });

    // No req.user here on purpose: this test predates parent/guardian
    // linking and shouldn't need to know about it — the controller must
    // tolerate a missing req.user (linkAccountsByEmail is a no-op anyway
    // since no email is given below).
    await createStudent(
      {
        body: {
          firstName: "Ari",
          lastName: "Bell",
          birthday: "2024-01-02",
          address: "Sample street",
          motherName: "Sample Mother",
          gender: "female",
          session: "morning",
        },
      },
      mockRes(),
      vi.fn(),
    );

    expect(prisma.student.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ gender: "female" }),
      }),
    );
  });

  it("updates a student's gender when provided", async () => {
    prisma.student.update.mockResolvedValue({
      id: 7,
      firstName: "Kai",
      lastName: "Moran",
      birthday: new Date("2023-03-04T00:00:00.000Z"),
      gender: "male",
      documents: [],
    });

    await updateStudent(
      {
        params: { id: "7" },
        body: { gender: "male" },
      },
      mockRes(),
      vi.fn(),
    );

    expect(prisma.student.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: expect.objectContaining({ gender: "male" }),
      }),
    );
  });
});

const baseBody = {
  firstName: "Juan",
  lastName: "Dela Cruz",
  birthday: "2021-03-04",
  gender: "male",
  address: "Angeles City",
  session: "morning",
  status: "active",
  guardianName: "Maria Dela Cruz",
  guardianPhone: "09171234567",
};

const staff = { id: 1, role: "Teacher" };

function stubStudentWrites() {
  prisma.student.create.mockResolvedValue({ id: 10, documents: [] });
  prisma.student.update.mockResolvedValue({ id: 10, birthday: new Date("2021-03-04"), documents: [] });
  prisma.parentChild.createMany.mockResolvedValue({ count: 1 });
}

describe("createStudent parent/guardian linking", () => {
  it("links existing Parent and Guardian accounts for every listed email", async () => {
    stubStudentWrites();
    prisma.user.findMany.mockResolvedValue([{ id: 7 }, { id: 8 }]);

    const req = {
      body: { ...baseBody, motherEmail: "Maria@Example.com", fatherEmail: "juan@example.com", guardianEmail: "" },
      user: staff,
    };
    const res = mockRes();
    const next = vi.fn();

    await createStudent(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    // Emails are canonicalized (lowercased) before lookup, and only these
    // two roles can ever be matched.
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { role: { in: ["Parent", "Guardian"] }, email: { in: ["maria@example.com", "juan@example.com"] } },
      select: { id: true },
    });
    expect(prisma.parentChild.createMany).toHaveBeenCalledWith({
      data: [
        { parentId: 7, studentId: 10 },
        { parentId: 8, studentId: 10 },
      ],
      skipDuplicates: true,
    });
  });

  it("skips the lookup entirely when no email is given", async () => {
    stubStudentWrites();

    const res = mockRes();
    await createStudent({ body: { ...baseBody }, user: staff }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(201);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.parentChild.createMany).not.toHaveBeenCalled();
  });

  it("creates the student without links (and no account) when nothing matches", async () => {
    stubStudentWrites();
    prisma.user.findMany.mockResolvedValue([]);

    const res = mockRes();
    await createStudent(
      { body: { ...baseBody, motherEmail: "nobody@example.com" }, user: staff },
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(prisma.parentChild.createMany).not.toHaveBeenCalled();
  });

  it("looks up each distinct email once when the same address is repeated", async () => {
    stubStudentWrites();
    prisma.user.findMany.mockResolvedValue([{ id: 7 }]);

    await createStudent(
      { body: { ...baseBody, motherEmail: "shared@example.com", fatherEmail: "SHARED@example.com" }, user: staff },
      mockRes(),
      vi.fn(),
    );

    expect(prisma.user.findMany.mock.calls[0][0].where.email).toEqual({ in: ["shared@example.com"] });
  });

  it("rejects an invalid email and creates nothing", async () => {
    const res = mockRes();
    const next = vi.fn();

    await createStudent({ body: { ...baseBody, motherEmail: "maria@" }, user: staff }, res, next);

    expect(next).toHaveBeenCalled();
    expect(prisma.student.create).not.toHaveBeenCalled();
    expect(prisma.parentChild.createMany).not.toHaveBeenCalled();
  });

  it("does not respond with account details or a generated password", async () => {
    stubStudentWrites();
    prisma.user.findMany.mockResolvedValue([{ id: 7 }]);

    const res = mockRes();
    await createStudent({ body: { ...baseBody, motherEmail: "maria@example.com" }, user: staff }, res, vi.fn());

    const body = JSON.stringify(res.json.mock.calls[0][0]);
    expect(body).not.toMatch(/password/i);
  });
});

describe("updateStudent parent/guardian linking", () => {
  const before = { motherEmail: "maria@example.com", fatherEmail: null, guardianEmail: null };

  it("links only emails that changed", async () => {
    stubStudentWrites();
    prisma.student.findUnique.mockResolvedValue(before);
    prisma.user.findMany.mockResolvedValue([{ id: 8 }]);

    const req = {
      params: { id: "10" },
      body: { motherEmail: "maria@example.com", fatherEmail: "Juan@Example.com" },
      user: staff,
    };
    await updateStudent(req, mockRes(), vi.fn());

    expect(prisma.user.findMany.mock.calls[0][0].where.email).toEqual({ in: ["juan@example.com"] });
    expect(prisma.parentChild.createMany).toHaveBeenCalledWith({
      data: [{ parentId: 8, studentId: 10 }],
      skipDuplicates: true,
    });
  });

  it("does not re-link on an unrelated edit, so removed links stay removed", async () => {
    stubStudentWrites();
    prisma.student.findUnique.mockResolvedValue(before);

    // The edit form resends every field, including unchanged emails.
    const req = {
      params: { id: "10" },
      body: { address: "New address", motherEmail: "maria@example.com", fatherEmail: "" },
      user: staff,
    };
    await updateStudent(req, mockRes(), vi.fn());

    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.parentChild.createMany).not.toHaveBeenCalled();
  });

  it("persists the selected primary guardian type", async () => {
    stubStudentWrites();
    prisma.student.findUnique.mockResolvedValue(before);

    await updateStudent(
      { params: { id: "10" }, body: { primaryGuardianType: "Father" }, user: staff },
      mockRes(),
      vi.fn(),
    );

    expect(prisma.student.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { primaryGuardianType: "Father" } }),
    );
  });

  it("rejects unsupported primary guardian types before writing", async () => {
    const next = vi.fn();

    await updateStudent(
      { params: { id: "10" }, body: { primaryGuardianType: "Sibling" }, user: staff },
      mockRes(),
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(prisma.student.update).not.toHaveBeenCalled();
  });

  it("never removes existing links when an email is cleared or changed", async () => {
    stubStudentWrites();
    prisma.student.findUnique.mockResolvedValue(before);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.parentChild.deleteMany = vi.fn();

    await updateStudent(
      { params: { id: "10" }, body: { motherEmail: "" }, user: staff },
      mockRes(),
      vi.fn(),
    );

    expect(prisma.parentChild.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 when the student does not exist", async () => {
    prisma.student.findUnique.mockResolvedValue(null);
    prisma.student.update.mockRejectedValue(Object.assign(new Error("missing"), { code: "P2025" }));

    const res = mockRes();
    await updateStudent({ params: { id: "999" }, body: { address: "x" }, user: staff }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("tolerates a missing req.user (e.g. a request made before auth middleware sets it)", async () => {
    stubStudentWrites();
    prisma.student.findUnique.mockResolvedValue(before);

    // No `user` on the request, and no email fields in the body either, so
    // linkAccountsByEmail is never actually reached — this only guards
    // against a crash from evaluating req.user.id as an argument.
    await expect(
      updateStudent({ params: { id: "10" }, body: { address: "New address" } }, mockRes(), vi.fn()),
    ).resolves.not.toThrow();
  });
});

describe("importStudents parent/guardian linking", () => {
  it("links each imported row and reports a bad row without linking it", async () => {
    stubStudentWrites();
    prisma.user.findMany.mockResolvedValue([{ id: 7 }]);

    const req = {
      body: {
        students: [
          { ...baseBody, motherEmail: "maria@example.com" },
          { ...baseBody, motherEmail: "not-an-email" },
        ],
      },
      user: staff,
    };
    const res = mockRes();
    await importStudents(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(201);
    const payload = res.json.mock.calls[0][0];
    expect(payload.imported).toBe(1);
    expect(payload.failed).toHaveLength(1);
    expect(prisma.parentChild.createMany).toHaveBeenCalledTimes(1);
  });
});
