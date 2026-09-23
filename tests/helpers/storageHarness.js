import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalStorage } from "../../src/storage/localDriver.js";
import { createS3Storage } from "../../src/storage/s3Driver.js";
import { startFakeS3, useFakeAwsCredentials } from "./fakeS3.js";

// Builds a ready-to-use storage of the requested kind plus the two things the
// tests need to observe it: the keys currently stored, and a way to reset.
export async function createHarness(kind) {
  if (kind === "local") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eccd-harness-"));
    return {
      storage: createLocalStorage(dir),
      keys: () => fs.readdirSync(dir),
      read: (key) => fs.readFileSync(path.join(dir, key)),
      reset: () => fs.readdirSync(dir).forEach((f) => fs.rmSync(path.join(dir, f))),
      close: async () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }

  useFakeAwsCredentials();
  const fake = await startFakeS3();
  return {
    storage: createS3Storage({ bucket: fake.bucket, region: "us-east-2", endpoint: fake.endpoint }),
    keys: () => [...fake.objects.keys()],
    read: (key) => fake.objects.get(key).body,
    reset: () => fake.objects.clear(),
    close: () => fake.close(),
    fake,
  };
}
