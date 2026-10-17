import { describe, it, expect } from "vitest";
import { isFilePath, isLiveAttendancePath, isNotificationPath } from "../src/middleware/rateLimit.js";

describe("isFilePath", () => {
  it("matches file downloads, and nothing that merely starts with 'files'", () => {
    expect(isFilePath("/files/abc.jpg")).toBe(true);
    expect(isFilePath("/files/")).toBe(true);
    expect(isFilePath("/filesystem")).toBe(false);
    expect(isFilePath("/students/1/files/x")).toBe(false);
    expect(isFilePath("/students")).toBe(false);
  });

  it("is independent of the other exemptions", () => {
    expect(isFilePath("/notifications")).toBe(false);
    expect(isNotificationPath("/files/a.jpg")).toBe(false);
    expect(isLiveAttendancePath("/files/a.jpg")).toBe(false);
  });
});
