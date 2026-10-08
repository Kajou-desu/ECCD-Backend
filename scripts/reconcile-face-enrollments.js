// Finds face enrollments that no longer belong to an active student.
//   npm run faces:reconcile                      report only (changes nothing)
//   npm run faces:reconcile -- --apply           erase enrollments whose student no longer exists
//   npm run faces:reconcile -- --apply --purge-inactive
//                                                also erase enrollments of INACTIVE students
// Safe to run on a schedule (e.g. weekly) with --apply. Only student ids are printed.
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { isRecognitionConfigured } from "../src/services/recognitionClient.js";
import { reconcileEnrollments } from "../src/services/enrollmentReconcile.js";

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => a !== "--apply" && a !== "--purge-inactive");
if (unknown.length) {
  console.error(`Unknown option: ${unknown.join(" ")}. See the comment at the top of this file.`);
  process.exit(1);
}
if (args.has("--purge-inactive") && !args.has("--apply")) {
  console.error("--purge-inactive only works together with --apply.");
  process.exit(1);
}

async function main() {
  if (!isRecognitionConfigured()) {
    console.log("Face recognition is not configured; nothing to reconcile.");
    return;
  }
  const result = await reconcileEnrollments({ apply: args.has("--apply"), purgeInactive: args.has("--purge-inactive") });
  console.log(`Enrolled students: ${result.enrolled}`);
  console.log(`No student record (orphans): ${result.orphans.length}${result.orphans.length ? ` -> ${result.orphans.join(", ")}` : ""}`);
  console.log(`Inactive students still enrolled: ${result.inactive.length}${result.inactive.length ? ` -> ${result.inactive.join(", ")}` : ""}`);
  if (!result.applied) {
    console.log("Report only. Re-run with --apply to erase the orphans (add --purge-inactive for inactive students too).");
    return;
  }
  console.log(`Erased: ${result.erased.length}`);
  if (result.failed.length) {
    console.error(`Could not erase: ${result.failed.join(", ")} (run again later)`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("Reconcile failed:", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
