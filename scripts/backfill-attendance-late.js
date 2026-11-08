// Fills in the stored "late" flag on attendance records from before it existed.
//   npm run attendance:backfill-late            report only (changes nothing)
//   npm run attendance:backfill-late -- --apply fix them
// Each record is judged ONCE with its student's session and center's school
// times as they are when this runs, so run it right after deploying, before
// anyone moves students or changes school times. Safe to run again: it only
// touches records that still have no answer. Prints counts only.
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { freezeLate, countUnfrozenLate } from "../src/services/lateBackfill.js";

const args = process.argv.slice(2);
if (args.some((a) => a !== "--apply")) {
  console.error("Unknown option. See the comment at the top of this file.");
  process.exit(1);
}

try {
  const pending = await countUnfrozenLate();
  console.log(`Records without a stored late flag: ${pending}`);
  if (!args.includes("--apply")) {
    console.log("Report only. Re-run with --apply to fix them.");
  } else {
    console.log(`Fixed: ${await freezeLate()}`);
  }
} catch (err) {
  console.error("Backfill failed:", err.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
