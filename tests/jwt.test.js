import { describe, it, expect, beforeAll } from "vitest";
import jwt from "jsonwebtoken";
import { signToken, verifyToken } from "../src/utils/jwt.js";

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.JWT_EXPIRES_IN = "1h";
});

const user = { id: 1, email: "user@example.com", role: "Admin", tokenVersion: 3 };

describe("signToken / verifyToken", () => {
  it("round-trips a valid token", () => {
    const token = signToken(user);
    const decoded = verifyToken(token);
    expect(decoded).toMatchObject({
      id: 1,
      email: "user@example.com",
      role: "Admin",
      tokenVersion: 3,
    });
  });

  it("only includes id/email/role/tokenVersion, ignoring extra fields on the user object", () => {
    const token = signToken({ ...user, isAdminOverride: true, passwordHash: "secret" });
    const decoded = jwt.decode(token);
    expect(decoded).not.toHaveProperty("isAdminOverride");
    expect(decoded).not.toHaveProperty("passwordHash");
  });

  it("rejects a token signed with a different secret", () => {
    const forged = jwt.sign(user, "wrong-secret-that-is-also-32-chars-long");
    expect(() => verifyToken(forged)).toThrow();
  });

  it("rejects a token with a malformed payload (wrong types)", () => {
    const badToken = jwt.sign(
      { id: "not-a-number", role: "Admin", tokenVersion: 1 },
      process.env.JWT_SECRET
    );
    expect(() => verifyToken(badToken)).toThrow("Malformed token payload");
  });

  it("rejects an expired token", () => {
    const expired = jwt.sign(
      { id: 1, email: "a@b.com", role: "Admin", tokenVersion: 1 },
      process.env.JWT_SECRET,
      { expiresIn: -10 }
    );
    expect(() => verifyToken(expired)).toThrow();
  });
});
