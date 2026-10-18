import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    accountActionOtp: { updateMany: vi.fn(), create: vi.fn() },
    activityLog: { create: vi.fn() },
  },
}));
vi.mock("../src/lib/mailer.js", () => ({ sendOtpEmail: vi.fn(), sendAttendanceEmail: vi.fn() }));

const { prisma } = await import("../src/lib/prisma.js");
const { signToken } = await import("../src/utils/jwt.js");
const { app } = await import("../src/app.js");

// A Bearer token, so the cookie/CSRF origin check never applies: any 403 below
// can only come from the role guard.
function auth(role) {
  const user = { id: 1, email: `${role.toLowerCase()}@school.test`, role, isActive: true, tokenVersion: 0 };
  prisma.user.findUnique.mockResolvedValue({ ...user, notifyByEmail: true, notifyBySms: true });
  return `Bearer ${signToken(user)}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.accountActionOtp.updateMany.mockResolvedValue({ count: 0 });
  prisma.accountActionOtp.create.mockResolvedValue({});
});

describe("notification channel settings are for parents and guardians only", () => {
  it.each(["Teacher", "Admin"])("403 for %s on preferences and push", async (role) => {
    const token = auth(role);
    expect((await request(app).get("/api/notifications/preferences").set("Authorization", token)).status).toBe(403);
    expect(
      (await request(app).put("/api/notifications/preferences").set("Authorization", token).send({ notifyByEmail: false })).status,
    ).toBe(403);
    expect((await request(app).get("/api/notifications/push/public-key").set("Authorization", token)).status).toBe(403);
    expect((await request(app).post("/api/notifications/push/subscribe").set("Authorization", token).send({})).status).toBe(403);
    expect((await request(app).post("/api/notifications/push/unsubscribe").set("Authorization", token).send({})).status).toBe(403);
  });

  it.each(["Parent", "Guardian"])("%s still reads their preferences", async (role) => {
    const res = await request(app).get("/api/notifications/preferences").set("Authorization", auth(role));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ notifyByEmail: true, notifyBySms: true });
  });

  it("every role can still list their in-app notifications", async () => {
    // not guarded: the bell is for everyone (the handler may fail on the bare mock, but never 401/403)
    for (const role of ["Teacher", "Admin", "Parent", "Guardian"]) {
      const res = await request(app).get("/api/notifications").set("Authorization", auth(role));
      expect([401, 403]).not.toContain(res.status);
    }
  });
});

describe("deleting your own account is Admin only", () => {
  it.each(["Teacher", "Parent", "Guardian"])("403 for %s, before any code is issued", async (role) => {
    const token = auth(role);
    expect((await request(app).post("/api/profile/me/delete/request-otp").set("Authorization", token)).status).toBe(403);
    expect(
      (await request(app).delete("/api/profile/me").set("Authorization", token).send({ password: "x", otpCode: "123456" })).status,
    ).toBe(403);
    expect(prisma.accountActionOtp.create).not.toHaveBeenCalled();
  });

  it("an Admin can still request the deletion code", async () => {
    const res = await request(app).post("/api/profile/me/delete/request-otp").set("Authorization", auth("Admin"));
    expect(res.status).toBe(200);
    expect(prisma.accountActionOtp.create).toHaveBeenCalledTimes(1);
  });
});
