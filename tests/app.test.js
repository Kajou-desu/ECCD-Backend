import { describe, it, expect, vi } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

// Mocking the shared Prisma module means every controller that imports it
// (transitively, via routes/index.js) gets this stub — good enough to
// exercise real routing/middleware without a live database.
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    user: { findUnique: vi.fn() },
  },
}));

const { app } = await import("../src/app.js");

describe("app wiring", () => {
  it("GET /health reports db connectivity", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "connected" });
  });

  it("mounts routes at both /api and /api/v1", async () => {
    const legacy = await request(app)
      .post("/api/login")
      .send({ email: "a@b.com", password: "x" });
    const versioned = await request(app)
      .post("/api/v1/login")
      .send({ email: "a@b.com", password: "x" });

    // Both should reach the same handler (401 = "reached login logic and
    // looked the user up", as opposed to 404 = "route doesn't exist").
    expect(legacy.status).not.toBe(404);
    expect(versioned.status).not.toBe(404);
  });

  it("accepts the standardized /auth/login alongside legacy /login", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "a@b.com", password: "x" });
    expect(res.status).not.toBe(404);
  });

  it("rejects protected routes without a token, without touching the DB", async () => {
    const { prisma } = await import("../src/lib/prisma.js");
    const res = await request(app).get("/api/students");

    expect(res.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns a generic 404 for unknown routes", async () => {
    const res = await request(app).get("/api/this-route-does-not-exist");
    expect(res.status).toBe(404);
  });

  it("sends security headers (helmet) and no x-powered-by", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("echoes the configured origin for an allowed client (never a wildcard)", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "http://localhost:5173");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("rejects a disallowed origin with a clean 403 and no CORS headers", async () => {
    // CORS was changed from a single fixed origin to an allow-list (multiple
    // client origins). A stranger's origin is refused outright — previously
    // this surfaced as a 500 and an error-level log line.
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://evil.example.com");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: "Not allowed by CORS" });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
