import { describe, it, expect, vi, beforeAll } from "vitest";
import { signFileUrl, verifyFileSignature } from "../src/lib/signedFileUrl.js";

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
});

function mockReq() {
  return {
    protocol: "https",
    get: (header) => (header === "host" ? "api.example.com" : undefined),
  };
}

describe("signFileUrl", () => {
  it("returns null/undefined/empty unchanged", () => {
    expect(signFileUrl(mockReq(), null)).toBeNull();
    expect(signFileUrl(mockReq(), undefined)).toBeUndefined();
    expect(signFileUrl(mockReq(), "")).toBe("");
  });

  it("builds a signed URL with exp and sig query params", () => {
    const url = signFileUrl(mockReq(), "abc123.jpg");
    expect(url).toMatch(
      /^https:\/\/api\.example\.com\/api\/files\/abc123\.jpg\?exp=\d+&sig=[0-9a-f]{64}$/
    );
  });

  it("extracts just the filename from a legacy full URL (no data migration needed)", () => {
    const url = signFileUrl(mockReq(), "http://old-host.example.com/api/files/abc123.jpg");
    expect(url).toContain("/api/files/abc123.jpg?");
    expect(url).not.toContain("old-host");
  });
});

describe("signFileUrl + verifyFileSignature round trip", () => {
  it("accepts a signature this exact process just issued", () => {
    const url = signFileUrl(mockReq(), "abc123.jpg");
    const { searchParams } = new URL(url);
    expect(verifyFileSignature("abc123.jpg", searchParams.get("exp"), searchParams.get("sig"))).toBe(
      true
    );
  });

  it("rejects a tampered filename (signature was for a different file)", () => {
    const url = signFileUrl(mockReq(), "abc123.jpg");
    const { searchParams } = new URL(url);
    expect(
      verifyFileSignature("other-file.jpg", searchParams.get("exp"), searchParams.get("sig"))
    ).toBe(false);
  });

  it("rejects an expired signature", () => {
    const url = signFileUrl(mockReq(), "abc123.jpg", -1000); // already expired
    const { searchParams } = new URL(url);
    expect(verifyFileSignature("abc123.jpg", searchParams.get("exp"), searchParams.get("sig"))).toBe(
      false
    );
  });

  it("rejects a forged signature", () => {
    expect(verifyFileSignature("abc123.jpg", Date.now() + 60_000, "not-the-real-signature")).toBe(
      false
    );
  });

  it("rejects when exp or sig is missing", () => {
    expect(verifyFileSignature("abc123.jpg", undefined, undefined)).toBe(false);
    expect(verifyFileSignature("abc123.jpg", Date.now() + 60_000, undefined)).toBe(false);
  });

  it("rejects a signature minted for a different secret (e.g. after a JWT_SECRET rotation)", () => {
    const url = signFileUrl(mockReq(), "abc123.jpg");
    const { searchParams } = new URL(url);
    const originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "a-completely-different-secret-1234567890";
    try {
      expect(
        verifyFileSignature("abc123.jpg", searchParams.get("exp"), searchParams.get("sig"))
      ).toBe(false);
    } finally {
      process.env.JWT_SECRET = originalSecret;
    }
  });
});
