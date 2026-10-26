import { describe, it, expect } from "vitest";
import {
  contentScopeFor,
  staffContentScopeFor,
  centerForNewContent,
  inContentScope,
  isMissingCenter,
  NO_CENTER_MESSAGE,
} from "../src/utils/contentScope.js";

const user = (role, centerId) => ({ id: 1, role, centerId });

describe("contentScopeFor (who may see materials and albums)", () => {
  it("is the user's own center for a Teacher, Parent and Guardian", () => {
    for (const role of ["Teacher", "Parent", "Guardian"]) {
      expect(contentScopeFor(user(role, 4))).toEqual({ centerId: 4 });
    }
  });

  it("is every center for an Admin, who has none of their own", () => {
    expect(contentScopeFor(user("Admin", null))).toEqual({});
  });

  it("denies (null) a user with no center, so callers can never default to everything", () => {
    for (const role of ["Teacher", "Parent", "Guardian"]) {
      expect(contentScopeFor(user(role, null))).toBeNull();
      expect(contentScopeFor({ id: 1, role })).toBeNull();
    }
  });

  it("denies any other role, or no user at all", () => {
    expect(contentScopeFor(user("Student", 4))).toBeNull();
    expect(contentScopeFor(user("", 4))).toBeNull();
    expect(contentScopeFor(undefined)).toBeNull();
    expect(contentScopeFor(null)).toBeNull();
  });

  it("does not treat a center id of 0 as 'no center'", () => {
    expect(contentScopeFor(user("Teacher", 0))).toEqual({ centerId: 0 });
  });
});

describe("staffContentScopeFor (changing content, or seeing who handed in what)", () => {
  it("gives a Teacher their center and an Admin everything", () => {
    expect(staffContentScopeFor(user("Teacher", 4))).toEqual({ centerId: 4 });
    expect(staffContentScopeFor(user("Admin", null))).toEqual({});
  });

  it("refuses a Teacher with no center, saying why", () => {
    expect(() => staffContentScopeFor(user("Teacher", null))).toThrow(NO_CENTER_MESSAGE);
    try {
      staffContentScopeFor(user("Teacher", null));
    } catch (err) {
      expect(err.status).toBe(403);
    }
  });

  it("refuses families, other roles and nobody (default deny)", () => {
    for (const who of [user("Parent", 4), user("Guardian", 4), user("Student", 4), undefined]) {
      expect(() => staffContentScopeFor(who)).toThrow("Forbidden");
    }
  });
});

describe("centerForNewContent (which center a new material or album goes to)", () => {
  it("is the Teacher's own center, and ignores any centerId they send", () => {
    expect(centerForNewContent({ user: user("Teacher", 4), body: { centerId: 99 } })).toBe(4);
    expect(centerForNewContent({ user: user("Teacher", 4) })).toBe(4);
  });

  it("refuses a Teacher with no center", () => {
    expect(() => centerForNewContent({ user: user("Teacher", null), body: { centerId: 4 } })).toThrow(NO_CENTER_MESSAGE);
  });

  it("is the center an Admin names, accepting a number or a digit string", () => {
    expect(centerForNewContent({ user: user("Admin", null), body: { centerId: 7 } })).toBe(7);
    expect(centerForNewContent({ user: user("Admin", null), body: { centerId: "7" } })).toBe(7);
  });

  it("rejects an Admin request without a usable center (400)", () => {
    for (const body of [undefined, {}, { centerId: "" }, { centerId: "abc" }, { centerId: 0 }, { centerId: -1 }, { centerId: "1e3" }]) {
      try {
        centerForNewContent({ user: user("Admin", null), body });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err.status).toBe(400);
      }
    }
  });

  it("refuses everyone else", () => {
    for (const who of [user("Parent", 4), user("Guardian", 4), undefined]) {
      expect(() => centerForNewContent({ user: who, body: { centerId: 4 } })).toThrow("Forbidden");
    }
  });
});

describe("inContentScope (a row that is already loaded)", () => {
  it("accepts any row for an Admin's scope, only the same center for a center scope", () => {
    expect(inContentScope({}, { centerId: 9 })).toBe(true);
    expect(inContentScope({}, { centerId: null })).toBe(true);
    expect(inContentScope({ centerId: 4 }, { centerId: 4 })).toBe(true);
    expect(inContentScope({ centerId: 4 }, { centerId: 5 })).toBe(false);
  });

  it("never matches a row with no center against a center, nor anything against a null scope", () => {
    expect(inContentScope({ centerId: 4 }, { centerId: null })).toBe(false);
    expect(inContentScope({ centerId: 4 }, {})).toBe(false);
    expect(inContentScope(null, { centerId: 4 })).toBe(false);
    expect(inContentScope({}, null)).toBe(false);
    expect(inContentScope({}, undefined)).toBe(false);
  });
});

describe("isMissingCenter", () => {
  it("recognises Prisma's foreign key failure only", () => {
    expect(isMissingCenter({ code: "P2003" })).toBe(true);
    expect(isMissingCenter({ code: "P2025" })).toBe(false);
    expect(isMissingCenter(new Error("x"))).toBe(false);
    expect(isMissingCenter(undefined)).toBe(false);
  });
});
