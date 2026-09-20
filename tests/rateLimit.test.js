import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { profileUpdateLimiter } from "../src/middleware/rateLimit.js";

// Same IP for every request (supertest), different authenticated users.
function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: Number(req.get("x-test-user")) };
    next();
  });
  app.put("/me", profileUpdateLimiter, (_req, res) => res.json({ ok: true }));
  return app;
}

describe("per-user limiters", () => {
  it("throttle one account without throttling other accounts on the same IP", async () => {
    const app = buildApp();

    let last;
    for (let i = 0; i < 21; i += 1) {
      last = await request(app).put("/me").set("x-test-user", "1");
    }
    expect(last.status).toBe(429); // user 1 exceeded the limit of 20

    const other = await request(app).put("/me").set("x-test-user", "2");
    expect(other.status).toBe(200); // user 2 (same IP — e.g. school Wi-Fi) is unaffected
  });
});
