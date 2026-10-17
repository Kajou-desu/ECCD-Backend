import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "https://app.school.test,http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { user: { findUnique: vi.fn() }, event: { create: vi.fn(), findMany: vi.fn() } },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { signToken } = await import("../src/utils/jwt.js");
const { app } = await import("../src/app.js");
const { readAuthCookie, setAuthCookie, clearAuthCookie, AUTH_COOKIE } = await import("../src/utils/authCookie.js");

const user = { id: 1, email: "t@school.test", role: "Teacher", isActive: true, tokenVersion: 0 };
const token = () => signToken(user);
const cookie = (value = token()) => `${AUTH_COOKIE}=${encodeURIComponent(value)}`;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue(user);
  prisma.event.findMany.mockResolvedValue([]);
  prisma.event.create.mockResolvedValue({ id: 1, title: "x" });
});

describe("readAuthCookie", () => {
  it("finds our cookie among others, and nothing else", () => {
    expect(readAuthCookie({ headers: { cookie: `a=1; ${AUTH_COOKIE}=abc.def; b=2` } })).toBe("abc.def");
    expect(readAuthCookie({ headers: { cookie: "a=1; b=2" } })).toBeNull();
    expect(readAuthCookie({ headers: { cookie: `x${AUTH_COOKIE}=abc` } })).toBeNull(); // a different name that ends the same
    expect(readAuthCookie({ headers: {} })).toBeNull();
    expect(readAuthCookie({ headers: { cookie: `${AUTH_COOKIE}=%E0%A4%A` } })).toBeNull(); // bad escape: no crash
  });
});

describe("setAuthCookie / clearAuthCookie", () => {
  it("sets httpOnly, SameSite and a lifetime matching the token; clears with the same attributes", () => {
    const res = { cookie: vi.fn(), clearCookie: vi.fn() };
    setAuthCookie(res, token());
    const [name, , opts] = res.cookie.mock.calls[0];
    expect(name).toBe(AUTH_COOKIE);
    expect(opts).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(opts.maxAge).toBeGreaterThan(23 * 3600 * 1000); // JWT_EXPIRES_IN defaults to 1d
    expect(opts.maxAge).toBeLessThanOrEqual(24 * 3600 * 1000);

    clearAuthCookie(res);
    expect(res.clearCookie).toHaveBeenCalledWith(AUTH_COOKIE, expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }));
  });
});

describe("requireAuth", () => {
  it("accepts the session cookie", async () => {
    const res = await request(app).get("/api/events").query({ month: "2026-10" }).set("Cookie", cookie());
    expect(res.status).toBe(200);
  });

  it("still accepts a Bearer header (API clients)", async () => {
    const res = await request(app).get("/api/events").query({ month: "2026-10" }).set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
  });

  it("rejects no credentials, a junk cookie, and a revoked token", async () => {
    expect((await request(app).get("/api/events").query({ month: "2026-10" })).status).toBe(401);
    expect((await request(app).get("/api/events").query({ month: "2026-10" }).set("Cookie", cookie("junk"))).status).toBe(401);
    prisma.user.findUnique.mockResolvedValue({ ...user, tokenVersion: 5 }); // signed out everywhere since
    expect((await request(app).get("/api/events").query({ month: "2026-10" }).set("Cookie", cookie())).status).toBe(401);
  });

  it("does not fall back to the cookie when an Authorization header is present but wrong", async () => {
    const res = await request(app)
      .get("/api/events")
      .query({ month: "2026-10" })
      .set("Authorization", "Basic abc")
      .set("Cookie", cookie());
    expect(res.status).toBe(401);
  });
});

describe("cookie-authenticated writes must come from our own frontend (CSRF)", () => {
  const body = { title: "Day", date: "2026-10-20", category: "Event" };

  it("allows a write whose Origin is a configured frontend", async () => {
    const res = await request(app).post("/api/events").set("Cookie", cookie()).set("Origin", "https://app.school.test").send(body);
    expect(res.status).toBe(201);
  });

  it("refuses a write from another origin, or with no Origin/Referer, before any handler runs", async () => {
    const evil = await request(app).post("/api/events").set("Cookie", cookie()).set("Origin", "https://evil.test").send(body);
    expect(evil.status).toBe(403);
    const none = await request(app).post("/api/events").set("Cookie", cookie()).send(body);
    expect(none.status).toBe(403);
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  it("uses the Referer when there is no Origin, and rejects one from elsewhere", async () => {
    const ok = await request(app).post("/api/events").set("Cookie", cookie()).set("Referer", "https://app.school.test/calendar").send(body);
    expect(ok.status).toBe(201);
    const bad = await request(app).post("/api/events").set("Cookie", cookie()).set("Referer", "https://evil.test/x").send(body);
    expect(bad.status).toBe(403);
  });

  it("does not affect reads, or Bearer clients that have nothing attached automatically", async () => {
    expect((await request(app).get("/api/events").query({ month: "2026-10" }).set("Cookie", cookie())).status).toBe(200); // reads carry no Origin requirement
    const bearer = await request(app).post("/api/events").set("Authorization", `Bearer ${token()}`).send(body);
    expect(bearer.status).toBe(201);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the cookie with 204 and needs no session", async () => {
    const res = await request(app).post("/api/auth/logout").set("Origin", "https://app.school.test");
    expect(res.status).toBe(204);
    const set = [res.headers["set-cookie"]].flat().join(";");
    expect(set).toContain(`${AUTH_COOKIE}=;`);
    expect(set).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(set).toContain("HttpOnly");
  });

  it("refuses a logout forged from another site while the cookie is attached", async () => {
    const res = await request(app).post("/api/auth/logout").set("Cookie", cookie()).set("Origin", "https://evil.test");
    expect(res.status).toBe(403);
  });
});
