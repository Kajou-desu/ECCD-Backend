// Runs `fn` over `items` with at most `limit` calls in flight at once and
// returns the results in the SAME ORDER as `items`. Used where independent
// database work (one student's rows each) would otherwise queue one after the
// other. The cap keeps a busy classroom from taking every database connection.
// If any call rejects, the first rejection is thrown once the running calls finish.
export async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker),
  );
  const failed = settled.find((s) => s.status === "rejected");
  if (failed) throw failed.reason;
  return results;
}

// How many students' signals are recorded at the same time.
export const SIGNAL_CONCURRENCY = 6;
