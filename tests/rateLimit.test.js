import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import {
  profileUpdateLimiter,
  authLimiter,
  authEmailLimiter,
  forgotPasswordLimiter,
  accountOtpLimiter,
} from "../src/middleware/rateLimit.js";

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

describe("auth limiters", () => {
  // Success/failure is decided by the body so one app covers both cases.
  function authApp() {
    const app = express();
    app.use(express.json());
    app.post("/login", authLimiter, authEmailLimiter, (req, res) =>
      res.status(req.body.ok ? 200 : 401).json({}),
    );
    return app;
  }

  it("do not count successful logins, so staff behind one NAT can all sign in", async () => {
    const app = authApp();
    for (let i = 0; i < 25; i += 1) {
      const res = await request(app).post("/login").send({ email: `teacher${i}@example.com`, ok: true });
      expect(res.status).toBe(200);
    }
  });

  it("still lock an account after repeated FAILED attempts", async () => {
    const app = authApp();
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await request(app).post("/login").send({ email: "victim@example.com", ok: false });
    }
    expect(last.status).toBe(429);
  });
});

describe("forgotPasswordLimiter", () => {
  it("counts every request even though the endpoint always answers 200", async () => {
    const app = express();
    app.post("/forgot", forgotPasswordLimiter, (_req, res) => res.json({ ok: true }));

    let last;
    for (let i = 0; i < 21; i += 1) last = await request(app).post("/forgot");
    expect(last.status).toBe(429);
  });
});

describe("accountOtpLimiter", () => {
  it("is per account, so one user's attempts don't block another on the same IP", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: Number(req.get("x-test-user")) };
      next();
    });
    app.post("/otp", accountOtpLimiter, (_req, res) => res.json({ ok: true }));

    let last;
    for (let i = 0; i < 11; i += 1) last = await request(app).post("/otp").set("x-test-user", "1");
    expect(last.status).toBe(429);

    const other = await request(app).post("/otp").set("x-test-user", "2");
    expect(other.status).toBe(200);
  });
});
