import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    notification: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
  dismissAllNotifications,
} = await import("../src/controllers/notifications.controller.js");

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

describe("getNotifications", () => {
  it("scopes the query to the current user", async () => {
    prisma.notification.findMany.mockResolvedValue([]);

    const req = { query: {}, user: { id: 7 } };
    const res = mockRes();
    const next = vi.fn();

    await getNotifications(req, res, next);

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 7 } }),
    );
  });

  it("filters to unread only when requested", async () => {
    prisma.notification.findMany.mockResolvedValue([]);

    const req = { query: { unread: "true" }, user: { id: 7 } };
    const res = mockRes();
    const next = vi.fn();

    await getNotifications(req, res, next);

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 7, isRead: false } }),
    );
  });
});

describe("markNotificationRead", () => {
  it("404s when the notification doesn't belong to the current user", async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });

    const req = { params: { id: "3" }, user: { id: 7 } };
    const res = mockRes();
    const next = vi.fn();

    await markNotificationRead(req, res, next);

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 3, userId: 7 },
      data: { isRead: true },
    });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("marks a matching notification as read", async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 1 });

    const req = { params: { id: "3" }, user: { id: 7 } };
    const res = mockRes();
    const next = vi.fn();

    await markNotificationRead(req, res, next);

    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalled();
  });
});

describe("markAllNotificationsRead", () => {
  it("scopes the bulk update to the current user's unread notifications", async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 2 });

    const req = { user: { id: 7 } };
    const res = mockRes();
    const next = vi.fn();

    await markAllNotificationsRead(req, res, next);

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 7, isRead: false },
      data: { isRead: true },
    });
  });
});

describe("dismissNotification", () => {
  it("404s when the notification doesn't belong to the current user", async () => {
    prisma.notification.deleteMany.mockResolvedValue({ count: 0 });

    const req = { params: { id: "3" }, user: { id: 7 } };
    const res = mockRes();
    const next = vi.fn();

    await dismissNotification(req, res, next);

    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({ where: { id: 3, userId: 7 } });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("deletes a matching notification", async () => {
    prisma.notification.deleteMany.mockResolvedValue({ count: 1 });

    const req = { params: { id: "3" }, user: { id: 7 } };
    const res = mockRes();
    const next = vi.fn();

    await dismissNotification(req, res, next);

    expect(res.status).toHaveBeenCalledWith(204);
  });
});

describe("dismissAllNotifications", () => {
  it("scopes the bulk delete to the current user", async () => {
    prisma.notification.deleteMany.mockResolvedValue({ count: 5 });

    const req = { user: { id: 7 } };
    const res = mockRes();
    const next = vi.fn();

    await dismissAllNotifications(req, res, next);

    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({ where: { userId: 7 } });
    expect(res.status).toHaveBeenCalledWith(204);
  });
});
