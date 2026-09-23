import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

// config/env.js validates on import and exits the process when configuration
// is unsafe, so each case boots it in a child process and checks the outcome.
function boot(extra = {}) {
  const env = {
    PATH: process.env.PATH,
    DATABASE_URL: "postgresql://x:x@localhost:5432/x",
    DIRECT_URL: "postgresql://x:x@localhost:5432/x",
    JWT_SECRET: "test-secret-at-least-32-characters-long",
    ...extra,
  };
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", 'const { env } = await import("./src/config/env.js"); console.log(JSON.stringify(env.storage));'],
    { env, encoding: "utf8", cwd: process.cwd() }
  );
  return { code: result.status, out: result.stdout.trim(), err: result.stderr };
}

describe("storage configuration", () => {
  it("defaults to local disk storage, no bucket needed", () => {
    const { code, out } = boot();
    expect(code).toBe(0);
    expect(JSON.parse(out).driver).toBe("local");
  });

  it("rejects an unknown driver", () => {
    const { code, err } = boot({ STORAGE_DRIVER: "ftp" });
    expect(code).toBe(1);
    expect(err).toMatch(/STORAGE_DRIVER/);
  });

  it("refuses to start with s3 selected but no bucket or region", () => {
    expect(boot({ STORAGE_DRIVER: "s3" }).code).toBe(1);
    expect(boot({ STORAGE_DRIVER: "s3", S3_BUCKET: "b" }).code).toBe(1);
    expect(boot({ STORAGE_DRIVER: "s3", AWS_REGION: "us-east-2" }).code).toBe(1);
  });

  it("Neon-style config is accepted", () => {
    const { code, out } = boot({
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "eccd-files",
      AWS_REGION: "ap-southeast-1",
      AWS_ENDPOINT_URL_S3: "https://br-x.storage.c-2.ap-southeast-1.aws.neon.tech",
    });
    expect(code).toBe(0);
    const storage = JSON.parse(out);
    expect(storage.s3.endpoint).toMatch(/neon\.tech$/);
    expect(storage.s3.bucket).toBe("eccd-files");
  });

  it("AWS-style config (no endpoint) is accepted", () => {
    const { code, out } = boot({ STORAGE_DRIVER: "s3", S3_BUCKET: "eccd-files", AWS_REGION: "ap-southeast-1" });
    expect(code).toBe(0);
    expect(JSON.parse(out).s3.endpoint).toBeUndefined();
  });

  it("rejects a malformed endpoint", () => {
    const { code, err } = boot({ STORAGE_DRIVER: "s3", S3_BUCKET: "b", AWS_REGION: "r", AWS_ENDPOINT_URL_S3: "not a url" });
    expect(code).toBe(1);
    expect(err).toMatch(/AWS_ENDPOINT_URL_S3/);
  });

  it("refuses a cleartext http:// endpoint in production (children's records must be encrypted in transit)", () => {
    const prod = {
      NODE_ENV: "production",
      SMTP_HOST: "h", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASS: "p",
      STORAGE_DRIVER: "s3", S3_BUCKET: "b", AWS_REGION: "r",
    };
    expect(boot({ ...prod, AWS_ENDPOINT_URL_S3: "http://storage.example.com" }).code).toBe(1);
    expect(boot({ ...prod, AWS_ENDPOINT_URL_S3: "https://storage.example.com" }).code).toBe(0);
  });

  it("allows http:// outside production (local test servers)", () => {
    const { code } = boot({ STORAGE_DRIVER: "s3", S3_BUCKET: "b", AWS_REGION: "r", AWS_ENDPOINT_URL_S3: "http://127.0.0.1:9000" });
    expect(code).toBe(0);
  });

  it("an explicit S3_FORCE_PATH_STYLE is passed through", () => {
    const base = { STORAGE_DRIVER: "s3", S3_BUCKET: "b", AWS_REGION: "r" };
    expect(JSON.parse(boot({ ...base, S3_FORCE_PATH_STYLE: "true" }).out).s3.forcePathStyle).toBe(true);
    expect(JSON.parse(boot({ ...base, S3_FORCE_PATH_STYLE: "false" }).out).s3.forcePathStyle).toBe(false);
    expect(JSON.parse(boot(base).out).s3.forcePathStyle).toBeUndefined();
  });
});
