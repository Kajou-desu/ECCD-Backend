import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildS3ClientConfig, createS3Storage } from "../src/storage/s3Driver.js";
import { startFakeS3, useFakeAwsCredentials } from "./helpers/fakeS3.js";

describe("swapping providers is configuration only", () => {
  it("Neon: a custom endpoint is used, with path-style addressing", () => {
    const config = buildS3ClientConfig({
      region: "us-east-2",
      endpoint: "https://br-winter-pond-aptw82ef.storage.c-2.us-east-2.aws.neon.tech",
    });
    expect(config.endpoint).toBe("https://br-winter-pond-aptw82ef.storage.c-2.us-east-2.aws.neon.tech");
    expect(config.forcePathStyle).toBe(true);
    expect(config.region).toBe("us-east-2");
  });

  it("AWS S3: no endpoint at all (the SDK derives it) and virtual-hosted addressing", () => {
    const config = buildS3ClientConfig({ region: "ap-southeast-1" });
    expect("endpoint" in config).toBe(false);
    expect(config.forcePathStyle).toBe(false);
  });

  it("an explicit S3_FORCE_PATH_STYLE overrides the inference either way", () => {
    expect(buildS3ClientConfig({ region: "r", endpoint: "https://x.example", forcePathStyle: false }).forcePathStyle).toBe(false);
    expect(buildS3ClientConfig({ region: "r", forcePathStyle: true }).forcePathStyle).toBe(true);
  });

  it("never puts credentials in the client config (the SDK's own chain supplies them)", () => {
    const config = buildS3ClientConfig({ region: "r", endpoint: "https://x.example" });
    expect(config.credentials).toBeUndefined();
  });

  it("only adds upload checksums when the API requires them (S3-compatible services can reject them)", () => {
    const config = buildS3ClientConfig({ region: "r" });
    expect(config.requestChecksumCalculation).toBe("WHEN_REQUIRED");
    expect(config.responseChecksumValidation).toBe("WHEN_REQUIRED");
  });
});

describe("S3 driver over the real AWS SDK", () => {
  let fakeS3;
  let workDir;
  let srcFile;
  beforeAll(async () => {
    useFakeAwsCredentials();
    fakeS3 = await startFakeS3();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eccd-s3-"));
    srcFile = path.join(workDir, "f.bin");
    fs.writeFileSync(srcFile, "hello world");
  });
  afterAll(async () => {
    await fakeS3.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const storage = () =>
    createS3Storage({ bucket: fakeS3.bucket, region: "us-east-2", endpoint: fakeS3.endpoint });

  it("addresses objects path-style (/<bucket>/<key>) on the configured endpoint", async () => {
    await storage().put("path-style.pdf", srcFile, "application/pdf");

    const put = fakeS3.requests.findLast((r) => r.method === "PUT");
    expect(put.path).toBe(`/${fakeS3.bucket}/path-style.pdf`);
  });

  it("signs every request with AWS Signature V4 using the environment credentials", async () => {
    await storage().put("signed.pdf", srcFile, "application/pdf");

    const auth = fakeS3.requests.findLast((r) => r.method === "PUT").headers.authorization;
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access-key\//);
  });

  it("stores the content type it was given", async () => {
    await storage().put("typed.pdf", srcFile, "application/pdf");
    expect(fakeS3.objects.get("typed.pdf").contentType).toBe("application/pdf");
  });

  it("sends the body as-is (no checksum framing that a non-AWS service could choke on)", async () => {
    await storage().put("plain-body.pdf", srcFile, "application/pdf");

    expect(fakeS3.objects.get("plain-body.pdf").body.toString()).toBe("hello world");
    const put = fakeS3.requests.findLast((r) => r.method === "PUT");
    expect(put.headers["content-encoding"]).toBeUndefined();
    expect(put.headers["x-amz-trailer"]).toBeUndefined();
  });

  it("treats a wrong bucket name as an ERROR, not as 'file not found'", async () => {
    const wrong = createS3Storage({ bucket: "no-such-bucket", region: "us-east-2", endpoint: fakeS3.endpoint });

    // (head can't tell these apart on real S3 — a HEAD 404 has no body — which
    // is why the startup check uses get.)
    await expect(wrong.get("anything.pdf")).rejects.toThrow();
    await expect(wrong.put("anything.pdf", srcFile, "application/pdf")).rejects.toThrow();
  });

  it("surfaces missing credentials as an error rather than a silent miss", async () => {
    const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      await expect(storage().head("x.pdf")).rejects.toThrow();
    } finally {
      process.env.AWS_ACCESS_KEY_ID = saved.id;
      process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
    }
  });
});
