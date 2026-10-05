import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

// config/env.js exits the process on unsafe config, so each case boots it in a
// child process (same approach as storage.env.test.js).
function boot(extra = {}) {
  const env = {
    PATH: process.env.PATH,
    DATABASE_URL: "postgresql://x:x@localhost:5432/x",
    DIRECT_URL: "postgresql://x:x@localhost:5432/x",
    JWT_SECRET: "test-secret-at-least-32-characters-long",
    RECOGNITION_SERVICE_KEY: "k".repeat(40),
    ...extra,
  };
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", 'const { env } = await import("./src/config/env.js"); console.log(env.recognition?.baseUrl);'],
    { env, encoding: "utf8", cwd: process.cwd() },
  );
  return { code: result.status, out: result.stdout.trim(), err: result.stderr };
}

// Production mode also insists on SMTP settings; these are placeholders.
const prod = {
  NODE_ENV: "production",
  CLIENT_ORIGIN: "https://app.example.com",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_USER: "user",
  SMTP_PASS: "pass",
};

describe("recognition service URL in production", () => {
  it("accepts https", () => {
    expect(boot({ ...prod, RECOGNITION_SERVICE_URL: "https://face.example.com" }).code).toBe(0);
  });

  it("accepts http on loopback", () => {
    expect(boot({ ...prod, RECOGNITION_SERVICE_URL: "http://127.0.0.1:8001" }).code).toBe(0);
  });

  it("accepts http on Railway's private network", () => {
    const { code, out } = boot({ ...prod, RECOGNITION_SERVICE_URL: "http://face.railway.internal:8001" });
    expect(code).toBe(0);
    expect(out).toBe("http://face.railway.internal:8001");
  });

  it("still rejects http on any other host, including look-alikes of the private domain", () => {
    for (const url of [
      "http://face.example.com:8001",
      "http://railway.internal.evil.com:8001",
      "http://evilrailway.internal:8001",
    ]) {
      const { code, err } = boot({ ...prod, RECOGNITION_SERVICE_URL: url });
      expect(code, url).toBe(1);
      expect(err).toMatch(/must use https/);
    }
  });
});
