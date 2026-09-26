import { describe, it, expect } from "vitest";
import { schoolDateString, schoolDateAsUtcMidnight, schoolWeekStart } from "../src/utils/schoolDate.js";

describe("schoolDateString", () => {
  it("uses the school's day, not UTC's, for early-morning arrivals", () => {
    // 7:30 AM in Manila (UTC+8) is 23:30 the previous day in UTC — exactly
    // the moment Start Attendance is pressed.
    const arrival = new Date("2026-09-19T23:30:00.000Z");
    expect(arrival.toISOString().slice(0, 10)).toBe("2026-09-19"); // what a UTC server would think
    expect(schoolDateString(arrival, "Asia/Manila")).toBe("2026-09-20");
  });

  it("rolls over at local midnight (16:00 UTC), not at UTC midnight", () => {
    expect(schoolDateString(new Date("2026-09-20T15:59:59.000Z"), "Asia/Manila")).toBe("2026-09-20");
    expect(schoolDateString(new Date("2026-09-20T16:00:00.000Z"), "Asia/Manila")).toBe("2026-09-21");
  });

  it("honours another timezone when given one", () => {
    expect(schoolDateString(new Date("2026-09-20T03:00:00.000Z"), "America/Los_Angeles")).toBe("2026-09-19");
  });

  it("defaults to the configured SCHOOL_TIMEZONE (Asia/Manila)", () => {
    expect(schoolDateString(new Date("2026-09-19T23:30:00.000Z"))).toBe("2026-09-20");
  });
});

describe("schoolDateAsUtcMidnight", () => {
  it("returns the school day as a UTC-midnight Date, matching attendance.controller's toDate()", () => {
    const d = schoolDateAsUtcMidnight(new Date("2026-09-19T23:30:00.000Z"), "Asia/Manila");
    expect(d.toISOString()).toBe("2026-09-20T00:00:00.000Z");
  });
});

describe("schoolWeekStart", () => {
  it("returns the same Monday for any day in that week", () => {
    // 2026-09-21 is a Monday, 2026-09-25 (Friday) is in the same week.
    const monday = schoolWeekStart(new Date("2026-09-21T02:00:00.000Z"), "Asia/Manila");
    const friday = schoolWeekStart(new Date("2026-09-25T10:00:00.000Z"), "Asia/Manila");
    expect(monday.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(friday.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("rolls a Sunday back to the previous Monday, not forward", () => {
    // 2026-09-27 is a Sunday; its week started 2026-09-21.
    const sunday = schoolWeekStart(new Date("2026-09-27T05:00:00.000Z"), "Asia/Manila");
    expect(sunday.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });
});
