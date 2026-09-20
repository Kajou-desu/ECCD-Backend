import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { Writable } from "node:stream";
import { createLogger } from "../src/lib/logger.js";
import { createHttpLogger } from "../src/lib/httpLogger.js";

// Builds a tiny app wired exactly like production (the real logger factory,
// the real http logger) but writing to memory so we can inspect what was logged.
function appWithCapturedLogs() {
  const lines = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger(sink); // the real production logger, writing to memory

  const app = express();
  app.use(createHttpLogger(logger));
  app.get("/api/files/:name", (_req, res) => res.json({ ok: true }));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  return { app, output: () => lines.join("") };
}

describe("request logging", () => {
  it("never writes the Authorization header (a live JWT) to the logs", async () => {
    const { app, output } = appWithCapturedLogs();
    await request(app)
      .get("/api/files/a.png")
      .set("Authorization", "Bearer super-secret-jwt-value");

    expect(output()).not.toContain("super-secret-jwt-value");
    expect(output()).toContain("[REDACTED]");
  });

  it("never writes cookies to the logs", async () => {
    const { app, output } = appWithCapturedLogs();
    await request(app).get("/api/files/a.png").set("Cookie", "session=cookie-secret-value");

    expect(output()).not.toContain("cookie-secret-value");
  });

  it("does not log the query string, so file-URL signatures stay out of log storage", async () => {
    const { app, output } = appWithCapturedLogs();
    await request(app).get("/api/files/a.png?exp=1893456000000&sig=deadbeefsignature");

    expect(output()).not.toContain("deadbeefsignature");
    expect(output()).toContain("/api/files/a.png"); // the path itself is still logged
  });

  it("still logs useful request metadata", async () => {
    const { app, output } = appWithCapturedLogs();
    await request(app).get("/api/files/a.png");

    const entry = JSON.parse(output().trim().split("\n")[0]);
    expect(entry.req.method).toBe("GET");
    expect(entry.res.statusCode).toBe(200);
  });

  it("skips health checks entirely", async () => {
    const { app, output } = appWithCapturedLogs();
    await request(app).get("/health");
    expect(output()).toBe("");
  });
});
