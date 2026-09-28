import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    student: { findUnique: vi.fn() },
    notification: { create: vi.fn() },
  },
}));
vi.mock("../src/lib/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { logger } = await import("../src/lib/logger.js");
const { notifyTeacherOfSubmission } = await import(
  "../src/services/submissionNotification.service.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.notification.create.mockResolvedValue({});
});

describe("notifyTeacherOfSubmission", () => {
  it("creates an in-app notification for the student's teacher", async () => {
    prisma.student.findUnique.mockResolvedValue({ name: "Ana Cruz", teacherId: 7 });

    await notifyTeacherOfSubmission(5, "Color the Shapes");

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: {
        userId: 7,
        title: "New submission",
        message: 'Ana Cruz submitted work for "Color the Shapes".',
      },
    });
  });

  it("does nothing when the student has no teacher assigned", async () => {
    prisma.student.findUnique.mockResolvedValue({ name: "Ana Cruz", teacherId: null });
    await notifyTeacherOfSubmission(5, "Color the Shapes");
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it("does nothing when the student doesn't exist", async () => {
    prisma.student.findUnique.mockResolvedValue(null);
    await notifyTeacherOfSubmission(5, "Color the Shapes");
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it("truncates very long material titles", async () => {
    prisma.student.findUnique.mockResolvedValue({ name: "Ana", teacherId: 7 });
    await notifyTeacherOfSubmission(5, "x".repeat(500));
    const { message } = prisma.notification.create.mock.calls[0][0].data;
    expect(message.length).toBeLessThan(150);
    expect(message).toContain("…");
  });

  it("never throws; logs the failure server-side", async () => {
    prisma.student.findUnique.mockRejectedValue(new Error("db down"));
    await expect(notifyTeacherOfSubmission(5, "T")).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
