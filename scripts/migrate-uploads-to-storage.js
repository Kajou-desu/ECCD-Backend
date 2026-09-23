// One-time (and safely repeatable) copy of files already on this server's
// disk into the configured bucket — run it BEFORE switching STORAGE_DRIVER
// to "s3". Usage:
//
//   npm run storage:migrate -- --dry-run     # report what would be copied
//   npm run storage:migrate                  # copy
//
// Needs the same S3 settings as the app (S3_BUCKET, AWS_REGION,
// AWS_ENDPOINT_URL_S3 for Neon, and AWS credentials). Never deletes anything.
import { env } from "../src/config/env.js";
import { UPLOAD_DIR } from "../src/storage/index.js";
import { createS3Storage } from "../src/storage/s3Driver.js";
import { migrateDirectoryToStorage } from "../src/storage/migrate.js";

const dryRun = process.argv.includes("--dry-run");
const dirFlag = process.argv.indexOf("--dir");
const dir = dirFlag > -1 ? process.argv[dirFlag + 1] : UPLOAD_DIR;

const { bucket, region } = env.storage.s3;
if (!bucket || !region) {
  console.error("Set S3_BUCKET and AWS_REGION (and AWS_ENDPOINT_URL_S3 for Neon) before migrating.");
  process.exit(1);
}

console.log(`${dryRun ? "[dry run] " : ""}Copying ${dir} -> bucket "${bucket}"`);

const summary = await migrateDirectoryToStorage({
  dir,
  destination: createS3Storage(env.storage.s3),
  dryRun,
});

const mb = (summary.bytes / 1024 / 1024).toFixed(1);
console.log(
  `${dryRun ? "Would copy" : "Copied"}: ${summary.transferred} file(s), ${mb} MB. ` +
    `Already present: ${summary.skipped}. Ignored: ${summary.ignored.length}. Failed: ${summary.failed.length}.`
);
for (const name of summary.ignored) console.log(`  ignored (unexpected filename): ${name}`);
for (const { key, error } of summary.failed) console.error(`  FAILED ${key}: ${error}`);

process.exit(summary.failed.length > 0 ? 1 : 0);
