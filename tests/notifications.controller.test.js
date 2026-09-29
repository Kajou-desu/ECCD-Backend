import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    notification: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const {
  getNotifications,
  getNotificationPreferences,
  updateNotificationPreferences,
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

describe("getNotificationPreferences", () => {
  it("reads the current user's own preferences, identified by the token", async () => {
    prisma.user.findUnique.mockResolvedValue({ notifyByEmail: true, notifyBySms: false });

    const req = { user: { id: 7 }, query: { userId: "999" } }; // a client-supplied id must be ignored
    const res = mockRes();
    const next = vi.fn();

    await getNotificationPreferences(req, res, next);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { notifyByEmail: true, notifyBySms: true },
    });
    expect(res.json).toHaveBeenCalledWith({ notifyByEmail: true, notifyBySms: false });
  });

  it("404s when the user row no longer exists", async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = mockRes();
    await getNotificationPreferences({ user: { id: 7 } }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("updateNotificationPreferences", () => {
  async function run(body) {
    const req = { user: { id: 7 }, body };
    const res = mockRes();
    const next = vi.fn();
    await updateNotificationPreferences(req, res, next);
    return { res, next };
  }

  it("updates only the caller's row and only the fields sent", async () => {
    prisma.user.update.mockResolvedValue({ notifyByEmail: true, notifyBySms: false });

    const { res, next } = await run({ notifyBySms: false });

    expect(next).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { notifyBySms: false },
      select: { notifyByEmail: true, notifyBySms: true },
    });
    expect(res.json).toHaveBeenCalledWith({ notifyByEmail: true, notifyBySms: false });
  });

  it("accepts both channels at once", async () => {
    prisma.user.update.mockResolvedValue({ notifyByEmail: false, notifyBySms: false });

    await run({ notifyByEmail: false, notifyBySms: false });

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { notifyByEmail: false, notifyBySms: false } }),
    );
  });

  it.each([
    ["an empty body", {}],
    ["a null body", null],
    ["an array body", [true]],
    ["a string instead of a boolean", { notifyByEmail: "false" }],
    ["a number instead of a boolean", { notifyBySms: 0 }],
    ["an unknown field", { notifyByEmail: true, role: "Admin" }],
    ["an id trying to target another user", { id: 1, notifyByEmail: true }],
    ["a __proto__ key", JSON.parse('{"__proto__": {"role": "Admin"}}')],
  ])("rejects %s without touching the database", async (_label, body) => {
    const { next } = await run(body);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].statusCode ?? next.mock.calls[0][0].status).toBe(400);
  });
});
