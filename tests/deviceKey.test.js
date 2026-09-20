import { describe, it, expect } from "vitest";
import {
  generateSecret,
  hashSecret,
  formatDeviceKey,
  parseDeviceKey,
  secretMatches,
} from "../src/utils/deviceKey.js";

describe("device keys", () => {
  it("round-trips: format -> parse gives back the id and secret", () => {
    const secret = generateSecret();
    expect(parseDeviceKey(formatDeviceKey(12, secret))).toEqual({ id: 12, secret });
  });

  it("generates 256-bit, non-repeating secrets", () => {
    const a = generateSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSecret()).not.toBe(a);
  });

  it.each([
    undefined, null, 42, "", "abc", "1.short", `0.${"a".repeat(64)}`, `-1.${"a".repeat(64)}`,
    `1.${"A".repeat(64)}`, `1.${"g".repeat(64)}`, `1.${"a".repeat(63)}`, `1.${"a".repeat(65)}`,
    `1234567890.${"a".repeat(64)}`, ` 1.${"a".repeat(64)}`, `1.${"a".repeat(64)}\n`, `1.${"a".repeat(64)}.x`,
  ])("rejects malformed key %j", (bad) => {
    expect(parseDeviceKey(bad)).toBeNull();
  });

  it("stores a hash, not the secret", () => {
    const secret = generateSecret();
    const hash = hashSecret(secret);
    expect(hash).not.toContain(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("secretMatches accepts the right secret and rejects everything else", () => {
    const secret = generateSecret();
    const hash = hashSecret(secret);
    expect(secretMatches(secret, hash)).toBe(true);
    expect(secretMatches(generateSecret(), hash)).toBe(false);
    expect(secretMatches(secret, "")).toBe(false);
    expect(secretMatches(secret, undefined)).toBe(false);
    expect(secretMatches(secret, "zz")).toBe(false);
    expect(secretMatches(secret, hash.slice(0, 62))).toBe(false);
  });
});
