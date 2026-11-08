import { describe, it, expect } from "vitest";
import {
  DEFAULT_SCHOOL_TIMES,
  parseClock,
  formatClock,
  requireSchoolTimes,
  toSchoolTimesResponse,
} from "../src/utils/schoolTimes.js";

const valid = { morningStart: "08:00", morningEnd: "10:30", afternoonStart: "13:00", afternoonEnd: "14:30" };

describe("parseClock / formatClock", () => {
  it.each([
    ["00:00", 0],
    ["08:30", 510],
    ["13:05", 785],
    ["23:59", 1439],
  ])("round-trips %s", (text, minutes) => {
    expect(parseClock(text, "t")).toBe(minutes);
    expect(formatClock(minutes)).toBe(text);
  });

  it.each([["8:00"], ["24:00"], ["12:60"], ["12:5"], ["12-30"], [" 12:30"], ["12:30 PM"], [830], [null], [undefined], [{}]])(
    "rejects %j",
    (value) => {
      expect(() => parseClock(value, "morningStart")).toThrow(/morningStart must be a 24-hour time/);
    },
  );
});

describe("requireSchoolTimes", () => {
  it("returns the stored minutes", () => {
    expect(requireSchoolTimes(valid)).toEqual({
      morningStartMin: 480,
      morningEndMin: 630,
      afternoonStartMin: 780,
      afternoonEndMin: 870,
    });
  });

  it("accepts a morning that ends exactly when the afternoon starts", () => {
    expect(() => requireSchoolTimes({ ...valid, morningEnd: "13:00" })).not.toThrow();
  });

  it("reads only the four time fields", () => {
    const times = requireSchoolTimes({ ...valid, centerId: 9, morningStartMin: 1, id: 4 });
    expect(Object.keys(times).sort()).toEqual(["afternoonEndMin", "afternoonStartMin", "morningEndMin", "morningStartMin"]);
    expect(times.morningStartMin).toBe(480);
  });

  it.each([
    ["a morning that ends before it starts", { morningStart: "11:00", morningEnd: "10:30" }, /morning session must end after/],
    ["a zero-length morning", { morningEnd: "08:00" }, /morning session must end after/],
    ["an afternoon that ends before it starts", { afternoonEnd: "12:00" }, /afternoon session must end after/],
    ["an afternoon starting before the morning ends", { morningEnd: "13:30" }, /cannot start before the morning/],
    ["a missing field", { afternoonEnd: undefined }, /afternoonEnd must be/],
    ["a malformed field", { morningStart: "8am" }, /morningStart must be/],
  ])("rejects %s", (_label, change, message) => {
    expect(() => requireSchoolTimes({ ...valid, ...change })).toThrow(message);
  });

  it.each([[undefined], [null], ["x"], [[]]])("rejects the body %j", (body) => {
    expect(() => requireSchoolTimes(body)).toThrow(/24-hour time/);
  });

  it("throws errors that are safe to show (status 400)", () => {
    try {
      requireSchoolTimes({});
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.expose).toBe(true);
    }
  });
});

describe("defaults and responses", () => {
  it("defaults keep the previous 8:00 AM / 1:00 PM late cutoffs", () => {
    expect(DEFAULT_SCHOOL_TIMES.morningStartMin).toBe(8 * 60);
    expect(DEFAULT_SCHOOL_TIMES.afternoonStartMin).toBe(13 * 60);
  });

  it("the defaults are themselves a valid configuration", () => {
    expect(() => requireSchoolTimes(toSchoolTimesResponse(DEFAULT_SCHOOL_TIMES))).not.toThrow();
  });

  it("is frozen so one request cannot change everyone's cutoffs", () => {
    expect(Object.isFrozen(DEFAULT_SCHOOL_TIMES)).toBe(true);
  });

  it("formats times for the API", () => {
    expect(toSchoolTimesResponse(DEFAULT_SCHOOL_TIMES)).toEqual(valid);
  });
});
