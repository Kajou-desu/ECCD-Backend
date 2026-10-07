import { describe, it, expect, vi } from "vitest";

vi.mock("../src/lib/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { errorHandler } = await import("../src/middleware/errorHandler.js");

function run(err) {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  errorHandler(err, { id: "r1", path: "/x", method: "POST" }, res, vi.fn());
  return res;
}

describe("errorHandler body-parser errors", () => {
  it("answers malformed JSON with a fixed message, never the parser's text", () => {
    const err = Object.assign(new SyntaxError("Unexpected token } in JSON at position 12"), {
      type: "entity.parse.failed",
      status: 400,
      expose: true,
    });
    const res = run(err);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "Invalid JSON" });
  });

  it("answers an oversized body with 413 and a fixed message", () => {
    const err = Object.assign(new Error("request entity too large"), {
      type: "entity.too.large",
      status: 413,
      expose: true,
    });
    const res = run(err);

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ message: "Payload too large" });
  });
});
