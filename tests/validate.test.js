import { describe, it, expect } from "vitest";
import {
  parseId,
  requireEmail,
  requireDateString,
  requireMonthString,
  requireAttendanceStatus,
  requireNonEmptyString,
  optionalString,
  optionalEmail,
  requirePhone,
  requireSession,
  requireStudentStatus,
  requireBirthday,
} from "../src/utils/validate.js";
import { AppError } from "../src/middleware/errorHandler.js";

describe("parseId", () => {
  it("accepts a positive integer string", () => {
    expect(parseId("42")).toBe(42);
  });

  it.each(["0", "-1", "abc", "1.5", "", undefined, null])(
    "rejects invalid id %p",
    (value) => {
      expect(() => parseId(value)).toThrow(AppError);
    }
  );
});

describe("requireEmail", () => {
  it("lowercases a valid email", () => {
    expect(requireEmail("User@Example.com")).toBe("user@example.com");
  });

  it.each(["not-an-email", "a@b", "", 123, null, undefined, "  user@example.com  "])(
    "rejects invalid email %p",
    (value) => {
      expect(() => requireEmail(value)).toThrow(AppError);
    }
  );
});

describe("optionalEmail", () => {
  it("returns null for empty/undefined/null", () => {
    expect(optionalEmail(undefined)).toBeNull();
    expect(optionalEmail(null)).toBeNull();
    expect(optionalEmail("")).toBeNull();
  });

  it("validates when a value is provided", () => {
    expect(optionalEmail("A@B.com")).toBe("a@b.com");
    expect(() => optionalEmail("nope")).toThrow(AppError);
  });
});

describe("requireDateString / requireMonthString", () => {
  it("accepts well-formed dates and months", () => {
    expect(requireDateString("2026-01-05")).toBe("2026-01-05");
    expect(requireMonthString("2026-01")).toBe("2026-01");
  });

  it.each(["2026/01/05", "01-05-2026", "2026-1-5", "", null])(
    "rejects malformed date %p",
    (value) => {
      expect(() => requireDateString(value)).toThrow(AppError);
    }
  );
});

describe("requireAttendanceStatus", () => {
  it.each(["present", "absent", "excused"])("accepts %p", (status) => {
    expect(requireAttendanceStatus(status)).toBe(status);
  });

  it("rejects anything else", () => {
    expect(() => requireAttendanceStatus("late")).toThrow(AppError);
  });
});

describe("requireSession / requireStudentStatus", () => {
  it("defaults when value is nullish", () => {
    expect(requireSession(undefined)).toBe("morning");
    expect(requireStudentStatus(undefined)).toBe("active");
  });

  it("rejects values outside the allowed set", () => {
    expect(() => requireSession("evening")).toThrow(AppError);
    expect(() => requireStudentStatus("graduated")).toThrow(AppError);
  });
});

describe("requireNonEmptyString / optionalString", () => {
  it("trims and enforces max length", () => {
    expect(requireNonEmptyString("  hi  ", "name")).toBe("hi");
    expect(() => requireNonEmptyString("  ", "name")).toThrow(AppError);
    expect(() => requireNonEmptyString("a".repeat(300), "name")).toThrow(AppError);
  });

  it("optionalString allows blank but validates length", () => {
    expect(optionalString(undefined)).toBeNull();
    expect(optionalString("")).toBeNull();
    expect(() => optionalString("a".repeat(2000))).toThrow(AppError);
  });
});

describe("requirePhone", () => {
  it("accepts common phone formats", () => {
    expect(requirePhone("+63 912 345 6789")).toBe("+63 912 345 6789");
  });

  it("rejects letters or too-short input", () => {
    expect(() => requirePhone("call me")).toThrow(AppError);
    expect(() => requirePhone("123")).toThrow(AppError);
  });
});

describe("requireBirthday", () => {
  it("parses a valid YYYY-MM-DD into a Date", () => {
    const result = requireBirthday("2020-06-15");
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe("2020-06-15T00:00:00.000Z");
  });

  it("rejects malformed birthdays", () => {
    expect(() => requireBirthday("15-06-2020")).toThrow(AppError);
  });
});
