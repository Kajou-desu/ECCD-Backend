import { describe, it, expect } from "vitest";
import { isLateArrival, lateCutoffFor } from "../src/utils/late.js";

// School time is Asia/Manila (UTC+8), so 00:30Z is 8:30 AM and 05:30Z is 1:30 PM.
const at = (iso) => new Date(iso);

describe("isLateArrival", () => {
  it("morning session: after 8:00 AM is late, 8:00 itself is not", () => {
    expect(isLateArrival("present", at("2026-09-02T00:00:00Z"), "morning")).toBe(false); // 8:00
    expect(isLateArrival("present", at("2026-09-02T00:01:00Z"), "morning")).toBe(true); // 8:01
    expect(isLateArrival("present", at("2026-09-01T23:50:00Z"), "morning")).toBe(false); // 7:50
  });

  it("afternoon session uses 1:00 PM", () => {
    expect(isLateArrival("present", at("2026-09-02T00:30:00Z"), "afternoon")).toBe(false); // 8:30 AM
    expect(isLateArrival("present", at("2026-09-02T05:30:00Z"), "afternoon")).toBe(true); // 1:30 PM
  });

  it("falls back to the morning cutoff when the session is missing", () => {
    expect(lateCutoffFor(undefined)).toBe(8 * 60);
    expect(isLateArrival("present", at("2026-09-02T00:30:00Z"), undefined)).toBe(true);
  });

  it("is never late without a real arrival time or without being present", () => {
    expect(isLateArrival("present", null, "morning")).toBe(false);
    expect(isLateArrival("absent", at("2026-09-02T00:30:00Z"), "morning")).toBe(false);
    expect(isLateArrival("excused", at("2026-09-02T00:30:00Z"), "morning")).toBe(false);
    expect(isLateArrival(undefined, at("2026-09-02T00:30:00Z"), "morning")).toBe(false);
  });
});
