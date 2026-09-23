import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateDirectoryToStorage } from "../src/storage/migrate.js";
import { createHarness } from "./helpers/storageHarness.js";

let sourceDir;
let harness;
beforeEach(async () => {
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "eccd-migrate-src-"));
  harness = await createHarness("s3");
});
afterEach(async () => {
  fs.rmSync(sourceDir, { recursive: true, force: true });
  await harness.close();
});

const seed = (name, content) => fs.writeFileSync(path.join(sourceDir, name), content);

describe("migrating the old uploads folder into a bucket", () => {
  it("copies every file under its existing name, with the right content type", async () => {
    seed("1758400000000-aaaaaaaaaaaaaaaa.pdf", "%PDF-1.4 one");
    seed("1758400000001-bbbbbbbbbbbbbbbb.png", "png-bytes");

    const summary = await migrateDirectoryToStorage({ dir: sourceDir, destination: harness.storage });

    expect(summary).toMatchObject({ transferred: 2, skipped: 0, failed: [] });
    expect(harness.keys().sort()).toEqual([
      "1758400000000-aaaaaaaaaaaaaaaa.pdf",
      "1758400000001-bbbbbbbbbbbbbbbb.png",
    ]);
    expect(harness.read("1758400000000-aaaaaaaaaaaaaaaa.pdf").toString()).toBe("%PDF-1.4 one");
    expect(harness.fake.objects.get("1758400000001-bbbbbbbbbbbbbbbb.png").contentType).toBe("image/png");
  });

  it("is safe to re-run: already-copied files are skipped, so an interrupted run resumes", async () => {
    seed("1-aaaaaaaaaaaaaaaa.pdf", "one");
    await migrateDirectoryToStorage({ dir: sourceDir, destination: harness.storage });
    seed("2-bbbbbbbbbbbbbbbb.pdf", "two");

    const again = await migrateDirectoryToStorage({ dir: sourceDir, destination: harness.storage });

    expect(again).toMatchObject({ transferred: 1, skipped: 1 });
  });

  it("re-copies a file whose stored copy has the wrong size (a truncated earlier upload)", async () => {
    seed("1-aaaaaaaaaaaaaaaa.pdf", "complete content");
    harness.fake.objects.set("1-aaaaaaaaaaaaaaaa.pdf", { body: Buffer.from("trunc"), contentType: "application/pdf" });

    const summary = await migrateDirectoryToStorage({ dir: sourceDir, destination: harness.storage });

    expect(summary.transferred).toBe(1);
    expect(harness.read("1-aaaaaaaaaaaaaaaa.pdf").toString()).toBe("complete content");
  });

  it("dry run reports what would be copied but changes nothing", async () => {
    seed("1-aaaaaaaaaaaaaaaa.pdf", "one");

    const summary = await migrateDirectoryToStorage({ dir: sourceDir, destination: harness.storage, dryRun: true });

    expect(summary.transferred).toBe(1);
    expect(harness.keys()).toEqual([]);
  });

  it("never deletes or modifies the originals", async () => {
    seed("1-aaaaaaaaaaaaaaaa.pdf", "keep me");
    await migrateDirectoryToStorage({ dir: sourceDir, destination: harness.storage });
    expect(fs.readFileSync(path.join(sourceDir, "1-aaaaaaaaaaaaaaaa.pdf"), "utf8")).toBe("keep me");
  });

  it("ignores dotfiles, subdirectories and names this app would never have generated", async () => {
    seed(".gitkeep", "");
    seed("has space.pdf", "x");
    fs.mkdirSync(path.join(sourceDir, "subdir"));
    seed("1-aaaaaaaaaaaaaaaa.pdf", "ok");

    const summary = await migrateDirectoryToStorage({ dir: sourceDir, destination: harness.storage });

    expect(summary.transferred).toBe(1);
    expect(summary.ignored).toEqual(["has space.pdf"]);
  });

  it("reports failures per file instead of aborting the whole run", async () => {
    seed("1-aaaaaaaaaaaaaaaa.pdf", "one");
    seed("2-bbbbbbbbbbbbbbbb.pdf", "two");
    let calls = 0;
    const flaky = {
      ...harness.storage,
      put: async (...args) => {
        calls += 1;
        if (calls === 1) throw new Error("network blip");
        return harness.storage.put(...args);
      },
    };

    const summary = await migrateDirectoryToStorage({ dir: sourceDir, destination: flaky });

    expect(summary.transferred).toBe(1);
    expect(summary.failed).toEqual([{ key: "1-aaaaaaaaaaaaaaaa.pdf", error: "network blip" }]);
  });

  it("does not count an upload as done unless the stored size checks out", async () => {
    seed("1-aaaaaaaaaaaaaaaa.pdf", "twelve bytes");
    const lossy = { ...harness.storage, put: async () => {} }; // claims success, stores nothing

    const summary = await migrateDirectoryToStorage({ dir: sourceDir, destination: lossy });

    expect(summary.transferred).toBe(0);
    expect(summary.failed[0].error).toMatch(/size mismatch/);
  });
});
