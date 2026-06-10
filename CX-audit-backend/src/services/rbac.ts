import type { Role, Team, User } from "../types.js";

/**
 * Central permission matrix. See docs/RBAC.md for the human-readable version.
 *
 * Summary:
 *   super_admin — org-wide. Manage admins + users, edit any team rubric, view all audits.
 *   admin       — team-scoped. Manage `user` accounts in their team, edit their team's
 *                 rubric, view their team's audits.
 *   user        — self only. View their own audits.
 */

export type Action =
  | "user.create"
  | "user.update"
  | "user.delete"
  | "rubric.edit"
  | "audit.viewAll"
  | "audit.viewTeam"
  | "audit.viewOwn";

const can = (...roles: Role[]) => (role: Role) => roles.includes(role);

const ROLE_RANK: Record<Role, number> = { user: 0, admin: 1, super_admin: 2 };

/**
 * Can `actor` create/modify/delete a target with `targetRole` on `targetTeam`?
 * Encapsulates the "who can manage whom" rules.
 */
export function canManageUser(
  actor: User,
  action: "create" | "update" | "delete",
  targetRole: Role,
  targetTeam: Team | null
): boolean {
  if (actor.role === "super_admin") return true;

  if (actor.role === "admin") {
    // Admins manage only plain users, and only within their own team.
    if (targetRole !== "user") return false;
    if (!actor.team) return false;
    return targetTeam === actor.team;
  }

  return false; // users manage no one
}

/** Can `actor` edit the rubric for `teamId`? */
export function canEditRubric(actor: User, teamId: Team): boolean {
  if (actor.role === "super_admin") return true;
  if (actor.role === "admin") return actor.team === teamId;
  return false;
}

/** Determines the audit visibility scope for a role. */
export function auditScope(role: Role): "all" | "team" | "own" {
  if (role === "super_admin") return "all";
  if (role === "admin") return "team";
  return "own";
}

export function atLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export const allow = { can, atLeast };
