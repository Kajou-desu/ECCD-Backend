import { beforeEach, describe, expect, it, vi } from "vitest";

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
    user: {
      findUnique: vi.fn(),
    },
    parentChild: {
      upsert: vi.fn(),
    },
    $transaction: vi.fn((callback) => callback(prisma)),
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { createStudent, updateStudent } = await import("../src/controllers/students.controller.js");

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
});

describe("student gender handling", () => {
  it("stores the selected gender when creating a student", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
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
