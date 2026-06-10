import { describe, it, expect } from "vitest";
import { canManageUser, canEditRubric, auditScope } from "./rbac.js";
import type { User } from "../types.js";

const make = (role: User["role"], team: User["team"] = null): User => ({
  user_id: "u",
  email: "u@scaler.com",
  name: "U",
  role,
  team,
  agent_id: null,
  status: "active",
  created_at: "",
  created_by: null,
  updated_at: "",
});

const superAdmin = make("super_admin");
const csAdmin = make("admin", "CS");
const rmAdmin = make("admin", "RM");
const user = make("user", "CS");

describe("canManageUser", () => {
  it("super_admin can manage anyone", () => {
    expect(canManageUser(superAdmin, "create", "admin", "CS")).toBe(true);
    expect(canManageUser(superAdmin, "delete", "super_admin", null)).toBe(true);
  });

  it("admin can only manage users in their own team", () => {
    expect(canManageUser(csAdmin, "create", "user", "CS")).toBe(true);
    expect(canManageUser(csAdmin, "create", "user", "RM")).toBe(false); // other team
    expect(canManageUser(csAdmin, "create", "admin", "CS")).toBe(false); // not a user
    expect(canManageUser(rmAdmin, "delete", "user", "CS")).toBe(false);
  });

  it("plain users can manage no one", () => {
    expect(canManageUser(user, "create", "user", "CS")).toBe(false);
  });
});

describe("canEditRubric", () => {
  it("super_admin edits any team; admin only their own", () => {
    expect(canEditRubric(superAdmin, "OORP")).toBe(true);
    expect(canEditRubric(csAdmin, "CS")).toBe(true);
    expect(canEditRubric(csAdmin, "RM")).toBe(false);
    expect(canEditRubric(user, "CS")).toBe(false);
  });
});

describe("auditScope", () => {
  it("maps roles to visibility", () => {
    expect(auditScope("super_admin")).toBe("all");
    expect(auditScope("admin")).toBe("team");
    expect(auditScope("user")).toBe("own");
  });
});
