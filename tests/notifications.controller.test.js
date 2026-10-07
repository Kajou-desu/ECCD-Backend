import { describe, it, expect, vi, beforeEach } from "vitest";

const vapidState = vi.hoisted(() => ({ configured: true, publicKey: "PUB-KEY" }));
vi.mock("../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { env: { ...actual.env, vapid: vapidState } };
});

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
    pushSubscription: {
      count: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const {
  getNotifications,
  getNotificationPreferences,
  updateNotificationPreferences,
  getPushPublicKey,
  subscribePush,
  unsubscribePush,
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
  vapidState.configured = true;
});

describe("getNotifications", () => {
  it("defaults to 100 rows, honours ?limit, and rejects more than 200", async () => {
    prisma.notification.findMany.mockResolvedValue([]);

    await getNotifications({ query: {}, user: { id: 7 } }, mockRes(), vi.fn());
    expect(prisma.notification.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 100 }));

    await getNotifications({ query: { limit: "25" }, user: { id: 7 } }, mockRes(), vi.fn());
    expect(prisma.notification.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 25 }));

    for (const limit of ["201", "0", "abc"]) {
      const next = vi.fn();
      prisma.notification.findMany.mockClear();
      await getNotifications({ query: { limit }, user: { id: 7 } }, mockRes(), next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
      expect(prisma.notification.findMany).not.toHaveBeenCalled();
    }
  });

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

describe("getPushPublicKey", () => {
  it("returns the public key when push is configured", () => {
    const res = mockRes();
    getPushPublicKey({}, res);
    expect(res.json).toHaveBeenCalledWith({ publicKey: "PUB-KEY" });
  });

  it("returns null (never the private key) when push isn't configured", () => {
    vapidState.configured = false;
    const res = mockRes();
    getPushPublicKey({}, res);
    expect(res.json).toHaveBeenCalledWith({ publicKey: null });
  });
});

describe("subscribePush", () => {
  const good = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" },
  };

  async function run(body, user = { id: 7 }) {
    const res = mockRes();
    const next = vi.fn();
    await subscribePush({ user, body }, res, next);
    return { res, next };
  }

  it("stores the subscription for the token's user, not one named in the body", async () => {
    prisma.pushSubscription.count.mockResolvedValue(0);
    prisma.pushSubscription.upsert.mockResolvedValue({});

    const { res, next } = await run({ ...good, userId: 999 });

    expect(next).not.toHaveBeenCalled();
    expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith({
      where: { endpoint: good.endpoint },
      create: { userId: 7, endpoint: good.endpoint, p256dh: good.keys.p256dh, auth: good.keys.auth },
      update: { userId: 7, p256dh: good.keys.p256dh, auth: good.keys.auth },
    });
    expect(res.json).toHaveBeenCalledWith({ subscribed: true });
  });

  it("refuses when push isn't configured on the server", async () => {
    vapidState.configured = false;
    const { next } = await run(good);
    expect(prisma.pushSubscription.upsert).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it.each([
    ["no body", null],
    ["an endpoint on an internal address (SSRF)", { ...good, endpoint: "http://169.254.169.254/latest" }],
    ["an endpoint on an unknown host", { ...good, endpoint: "https://evil.example.com/x" }],
    ["missing keys", { endpoint: good.endpoint }],
    ["keys that aren't base64url", { ...good, keys: { p256dh: "not base64!", auth: good.keys.auth } }],
    ["an over-long key", { ...good, keys: { p256dh: "a".repeat(200), auth: good.keys.auth } }],
    ["a missing auth secret", { ...good, keys: { p256dh: good.keys.p256dh } }],
  ])("rejects %s without touching the database", async (_label, body) => {
    const { next } = await run(body);

    expect(prisma.pushSubscription.upsert).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("caps how many devices one user can register, excluding the one being re-registered", async () => {
    prisma.pushSubscription.count.mockResolvedValue(10);

    const { next } = await run(good);

    expect(prisma.pushSubscription.count).toHaveBeenCalledWith({
      where: { userId: 7, endpoint: { not: good.endpoint } },
    });
    expect(prisma.pushSubscription.upsert).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0].status).toBe(400);
  });
});

describe("unsubscribePush", () => {
  it("deletes only the caller's own subscription for that endpoint", async () => {
    prisma.pushSubscription.deleteMany.mockResolvedValue({ count: 1 });

    const res = mockRes();
    const next = vi.fn();
    await unsubscribePush({ user: { id: 7 }, body: { endpoint: "https://fcm.googleapis.com/x" } }, res, next);

    expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { endpoint: "https://fcm.googleapis.com/x", userId: 7 },
    });
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("succeeds even if the subscription is already gone", async () => {
    prisma.pushSubscription.deleteMany.mockResolvedValue({ count: 0 });

    const res = mockRes();
    await unsubscribePush({ user: { id: 7 }, body: { endpoint: "https://fcm.googleapis.com/x" } }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(204);
  });

  it.each([["no body", undefined], ["a non-string endpoint", { endpoint: { $ne: "" } }], ["an empty endpoint", { endpoint: "" }]])(
    "rejects %s",
    async (_label, body) => {
      const next = vi.fn();
      await unsubscribePush({ user: { id: 7 }, body }, mockRes(), next);

      expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
      expect(next.mock.calls[0][0].status).toBe(400);
    },
  );
});
