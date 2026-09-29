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
    NODE_ENV: "production",
    CLIENT_ORIGIN: "https://app.example.com",
    ...extra,
  };
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const { env } = await import("./src/config/env.js"); console.log(env.emailConfigured);',
    ],
    { env, encoding: "utf8", cwd: process.cwd() },
  );
  return { code: result.status, out: result.stdout.trim(), err: result.stderr };
}

describe("email config in production", () => {
  it("refuses to start with neither RESEND_API_KEY nor SMTP settings", () => {
    const { code, err } = boot();
    expect(code).toBe(1);
    expect(err).toMatch(/RESEND_API_KEY/);
  });

  it("starts with only RESEND_API_KEY (no SMTP needed)", () => {
    const { code, out } = boot({ RESEND_API_KEY: "re_test_key" });
    expect(code).toBe(0);
    expect(out).toBe("true");
  });

  it("still starts with the full SMTP settings and no Resend key", () => {
    const { code } = boot({ SMTP_HOST: "h", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASS: "p" });
    expect(code).toBe(0);
  });

  it("does not treat partial SMTP settings as configured", () => {
    expect(boot({ SMTP_HOST: "h", SMTP_PORT: "587" }).code).toBe(1);
  });
});
