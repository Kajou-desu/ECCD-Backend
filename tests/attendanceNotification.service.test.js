import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    student: { findUnique: vi.fn() },
    parentChild: { findMany: vi.fn() },
    notification: { create: vi.fn() },
  },
}));
vi.mock("../src/lib/mailer.js", () => ({ sendAttendanceEmail: vi.fn() }));
vi.mock("../src/lib/sms.js", () => ({ sendSms: vi.fn() }));
// Errors are expected to be logged (that's the point of this service) —
// stub the logger so a passing test doesn't print noise, and so we can
// assert on it where relevant.
vi.mock("../src/lib/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { sendAttendanceEmail } = await import("../src/lib/mailer.js");
const { sendSms } = await import("../src/lib/sms.js");
const { logger } = await import("../src/lib/logger.js");
const { notifyArrival, notifyDeparture } = await import(
  "../src/services/attendanceNotification.service.js"
);

const NOW = new Date("2026-09-28T00:30:00.000Z"); // 8:30 AM in Asia/Manila (default school tz)

function parent(over = {}) {
  return { parent: { id: 1, email: "mom@example.com", phone: "09171234567", ...over } };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.notification.create.mockResolvedValue({});
  sendAttendanceEmail.mockResolvedValue(undefined);
  sendSms.mockResolvedValue(undefined);
});

describe("notifyArrival", () => {
  it("does nothing if the student can't be found", async () => {
    prisma.student.findUnique.mockResolvedValue(null);
    prisma.parentChild.findMany.mockResolvedValue([parent()]);

    await notifyArrival(5, NOW);

    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(sendAttendanceEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("does nothing if the student has no linked parent/guardian", async () => {
    prisma.student.findUnique.mockResolvedValue({ name: "Ana Cruz" });
    prisma.parentChild.findMany.mockResolvedValue([]);

    await notifyArrival(5, NOW);

    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(sendAttendanceEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("notifies every linked parent on every channel they have contact info for", async () => {
    prisma.student.findUnique.mockResolvedValue({ name: "Ana Cruz" });
    prisma.parentChild.findMany.mockResolvedValue([
      parent({ id: 1, email: "mom@example.com", phone: "09171234567" }),
      parent({ id: 2, email: "dad@example.com", phone: null }),
    ]);

    await notifyArrival(5, NOW);

    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: { userId: 1, title: "Arrival", message: expect.stringContaining("Ana Cruz arrived at school") },
    });
    expect(sendAttendanceEmail).toHaveBeenCalledTimes(2);
    expect(sendAttendanceEmail).toHaveBeenCalledWith(
      "mom@example.com",
      expect.stringContaining("Ana Cruz has arrived"),
      expect.stringContaining("Ana Cruz arrived at school")
    );
    // Only the parent with a phone number gets an SMS.
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms).toHaveBeenCalledWith("09171234567", expect.stringContaining("Ana Cruz arrived at school"));
  });

  it("keeps going for other parents/channels when one channel fails", async () => {
    prisma.student.findUnique.mockResolvedValue({ name: "Ana Cruz" });
    prisma.parentChild.findMany.mockResolvedValue([
      parent({ id: 1, email: "mom@example.com", phone: "09171234567" }),
      parent({ id: 2, email: "dad@example.com", phone: "09181234567" }),
    ]);
    sendAttendanceEmail.mockRejectedValueOnce(new Error("SMTP down"));
    sendSms.mockRejectedValueOnce(new Error("bad number"));

    await notifyArrival(5, NOW);

    // Both parents still got their in-app notification and their other channel.
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
    expect(sendAttendanceEmail).toHaveBeenCalledTimes(2);
    expect(sendSms).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });

  it("never throws, even if the initial lookup itself fails", async () => {
    prisma.student.findUnique.mockRejectedValue(new Error("connection lost"));
    prisma.parentChild.findMany.mockResolvedValue([]);

    await expect(notifyArrival(5, NOW)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("notifyDeparture", () => {
  it("sends a departure-worded message on every channel", async () => {
    prisma.student.findUnique.mockResolvedValue({ name: "Ana Cruz" });
    prisma.parentChild.findMany.mockResolvedValue([parent()]);

    await notifyDeparture(5, NOW);

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: { userId: 1, title: "Departure", message: expect.stringContaining("Ana Cruz has departed from school") },
    });
    expect(sendAttendanceEmail).toHaveBeenCalledWith(
      "mom@example.com",
      expect.stringContaining("Ana Cruz has departed"),
      expect.stringContaining("Ana Cruz has departed from school")
    );
    expect(sendSms).toHaveBeenCalledWith("09171234567", expect.stringContaining("Ana Cruz has departed from school"));
  });
});
