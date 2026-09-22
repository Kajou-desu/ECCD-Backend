import { describe, it, expect } from "vitest";
import { normalizeMac } from "../src/utils/macAddress.js";

describe("normalizeMac", () => {
  it("upper-cases, trims and accepts ':' or '-' separators", () => {
    expect(normalizeMac("d7:40:47:15:14:90")).toBe("D7:40:47:15:14:90");
    expect(normalizeMac("  D7-40-47-15-14-90 ")).toBe("D7:40:47:15:14:90");
  });

  it.each([
    undefined, null, 5, {}, "", "D7:40:47:15:14", "D7:40:47:15:14:90:00", "D7404715149 0",
    "D740.4715.1490", "GG:40:47:15:14:90", "D7:40:47:15:14:9", "D7:40-47:15:14:90x", "D7:40:47:15:14:90\n; DROP",
  ])("rejects %j", (bad) => {
    expect(normalizeMac(bad)).toBeNull();
  });
});
