import { describe, it, expect, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

const { touchCamera, isCameraAlive, CAMERA_ALIVE_MS, CAMERA_ROLES } = await import("../src/lib/hardwareStatus.js");

const NOW = new Date("2026-10-12T02:40:00.000Z");
const later = (ms) => new Date(NOW.getTime() + ms);

describe("camera liveness per center and per camera role", () => {
  it("knows exactly two roles", () => {
    expect(CAMERA_ROLES).toEqual(["entry", "exit"]);
  });

  it("the entry camera being up says nothing about the exit camera", () => {
    touchCamera(101, NOW, "entry");
    expect(isCameraAlive(101, later(1000), "entry")).toBe(true);
    expect(isCameraAlive(101, later(1000), "exit")).toBe(false);
  });

  it("each center has its own cameras", () => {
    touchCamera(102, NOW, "exit");
    expect(isCameraAlive(102, later(1000), "exit")).toBe(true);
    expect(isCameraAlive(103, later(1000), "exit")).toBe(false);
  });

  it("a camera counts as alive for CAMERA_ALIVE_MS after its last frame, then not", () => {
    touchCamera(104, NOW, "exit");
    expect(isCameraAlive(104, later(CAMERA_ALIVE_MS), "exit")).toBe(true);
    expect(isCameraAlive(104, later(CAMERA_ALIVE_MS + 1), "exit")).toBe(false);
  });

  it("defaults to the entry camera, as before there were two", () => {
    touchCamera(105, NOW);
    expect(isCameraAlive(105, later(1000))).toBe(true);
    expect(isCameraAlive(105, later(1000), "exit")).toBe(false);
  });

  it("centers without an id share one key per role", () => {
    touchCamera(null, NOW, "exit");
    expect(isCameraAlive(null, later(1000), "exit")).toBe(true);
    expect(isCameraAlive(null, later(1000), "entry")).toBe(false);
  });
});
