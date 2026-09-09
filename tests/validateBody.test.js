import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { validateBody } from "../src/middleware/validateBody.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("validateBody", () => {
  const schema = z.object({
    email: z.string().min(1),
    password: z.string().min(1),
  });

  it("calls next() and normalizes req.body on valid input", () => {
    const req = { body: { email: "a@b.com", password: "hunter2" } };
    const res = mockRes();
    const next = vi.fn();

    validateBody(schema)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.body).toEqual({ email: "a@b.com", password: "hunter2" });
  });

  it("responds 400 and does not call next() on missing fields", () => {
    const req = { body: { email: "a@b.com" } };
    const res = mockRes();
    const next = vi.fn();

    validateBody(schema)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Invalid input" })
    );
  });

  it("strips unknown fields rather than passing them through untouched", () => {
    // Zod's default (non-strict) object parsing drops keys not in the
    // schema — confirms callers can't smuggle extra fields through.
    const req = { body: { email: "a@b.com", password: "x", isAdmin: true } };
    const res = mockRes();
    const next = vi.fn();

    validateBody(schema)(req, res, next);

    expect(req.body).not.toHaveProperty("isAdmin");
  });
});
