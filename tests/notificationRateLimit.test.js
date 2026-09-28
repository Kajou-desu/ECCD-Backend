import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import {
  apiLimiter,
  isNotificationPath,
  notificationUserLimiter,
} from "../src/middleware/rateLimit.js";

describe("isNotificationPath", () => {
  it("matches the notifications router and only it", () => {
    expect(isNotificationPath("/notifications")).toBe(true);
    expect(isNotificationPath("/notifications/")).toBe(true);
    expect(isNotificationPath("/notifications/12/read")).toBe(true);
    expect(isNotificationPath("/notificationsX")).toBe(false);
    expect(isNotificationPath("/students/1/notifications")).toBe(false);
  });
});

describe("notification polling vs the shared per-IP limiter", () => {
  it("does not consume the general API budget", async () => {
    const app = express();
    app.use("/api", apiLimiter, (_req, res) => res.json({ ok: true }));

    const before = await request(app).get("/api/students");
    const remainingBefore = Number(before.headers["ratelimit-remaining"]);

    for (let i = 0; i < 10; i += 1) {
      const r = await request(app).get("/api/notifications");
      expect(r.status).toBe(200);
      // Skipped requests are never counted, so no limiter headers at all.
      expect(r.headers["ratelimit-remaining"]).toBeUndefined();
    }

    const after = await request(app).get("/api/students");
    expect(Number(after.headers["ratelimit-remaining"])).toBe(remainingBefore - 1);
  });
});

describe("notificationUserLimiter", () => {
  it("throttles one account without throttling others on the same IP", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: Number(req.get("x-test-user")) };
      next();
    });
    app.get("/n", notificationUserLimiter, (_req, res) => res.json({ ok: true }));

    let last;
    for (let i = 0; i < 201; i += 1) {
      last = await request(app).get("/n").set("x-test-user", "1");
    }
    expect(last.status).toBe(429); // user 1 exceeded 200 / 15 min

    const other = await request(app).get("/n").set("x-test-user", "2");
    expect(other.status).toBe(200); // same school IP, different user: unaffected
  });
});
