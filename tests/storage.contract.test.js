import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalStorage } from "../src/storage/localDriver.js";
import { createS3Storage } from "../src/storage/s3Driver.js";
import { startFakeS3, useFakeAwsCredentials } from "./helpers/fakeS3.js";

// The SAME assertions run against every driver. If a driver passes this, the
// rest of the app can't tell it apart from any other — which is the whole
// basis for swapping Neon <-> AWS S3 <-> local by configuration alone.
let fakeS3;
let workDir;
let srcFile;
const drivers = {};

beforeAll(async () => {
  useFakeAwsCredentials();
  fakeS3 = await startFakeS3();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eccd-contract-"));
  srcFile = path.join(workDir, "source.bin");
  fs.writeFileSync(srcFile, "hello world");
  drivers.local = createLocalStorage(path.join(workDir, "objects"));
  drivers["s3 (Neon-style: custom endpoint)"] = createS3Storage({
    bucket: fakeS3.bucket,
    region: "us-east-2",
    endpoint: fakeS3.endpoint,
  });
});
afterAll(async () => {
  await fakeS3.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

const readAll = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
};

describe.each(["local", "s3 (Neon-style: custom endpoint)"])("storage contract: %s", (name) => {
  const driver = () => drivers[name];

  it("stores an object and reads it back byte for byte, with its length", async () => {
    await driver().put("contract-a.pdf", srcFile, "application/pdf");

    const object = await driver().get("contract-a.pdf");
    expect(object.contentLength).toBe(11);
    expect(await readAll(object.body)).toBe("hello world");
  });

  it("head reports the size of an existing object", async () => {
    await driver().put("contract-b.pdf", srcFile, "application/pdf");
    expect(await driver().head("contract-b.pdf")).toEqual({ size: 11 });
  });

  it("returns null (not an error) for an object that doesn't exist", async () => {
    expect(await driver().get("contract-missing.pdf")).toBeNull();
    expect(await driver().head("contract-missing.pdf")).toBeNull();
  });

  it("overwrites an existing key", async () => {
    await driver().put("contract-c.pdf", srcFile, "application/pdf");
    fs.writeFileSync(srcFile, "hello world!!");
    await driver().put("contract-c.pdf", srcFile, "application/pdf");
    fs.writeFileSync(srcFile, "hello world");

    expect(await driver().head("contract-c.pdf")).toEqual({ size: 13 });
  });

  it("removes an object, and removing it again is not an error", async () => {
    await driver().put("contract-d.pdf", srcFile, "application/pdf");

    await driver().remove("contract-d.pdf");
    await expect(driver().remove("contract-d.pdf")).resolves.toBeUndefined();

    expect(await driver().get("contract-d.pdf")).toBeNull();
  });
});
