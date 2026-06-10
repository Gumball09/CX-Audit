import { Router } from "express";
import { logger } from "../logger.js";
import { isEmail } from "../validation.js";
import { requireRole } from "../services/auth.js";
import { canManageUser } from "../services/rbac.js";
import {
  listUsers,
  getUser,
  getUserByEmail,
  putUser,
  updateUser,
  deleteUser,
  newUserId,
} from "../db/users.js";
import type { Role, Team, User } from "../types.js";

export const usersRouter = Router();

const ROLES: Role[] = ["super_admin", "admin", "user"];
const TEAMS: Team[] = ["CS", "RM", "OORP", "Escalations"];

/** GET /api/users — admins and super_admins may list users. */
usersRouter.get("/", requireRole("admin", "super_admin"), async (req, res) => {
  const all = await listUsers();
  // Admins only see their own team (plus themselves).
  const visible =
    req.user!.role === "super_admin"
      ? all
      : all.filter((u) => u.team === req.user!.team || u.user_id === req.user!.user_id);
  res.json(visible);
});

/** POST /api/users — create an admin (super_admin) or user (admin+). */
usersRouter.post("/", requireRole("admin", "super_admin"), async (req, res) => {
  const { email, name, role, team, agent_id } = req.body as Partial<User>;

  if (!isEmail(email)) return res.status(400).json({ message: "Valid email required." });
  if (!name?.trim()) return res.status(400).json({ message: "Name required." });
  if (!role || !ROLES.includes(role)) return res.status(400).json({ message: "Valid role required." });
  if (team && !TEAMS.includes(team)) return res.status(400).json({ message: "Invalid team." });

  if (!canManageUser(req.user!, "create", role, team ?? null)) {
    return res.status(403).json({ message: "You cannot create a user with that role/team." });
  }
  if (await getUserByEmail(email)) {
    return res.status(409).json({ message: "A user with that email already exists." });
  }

  const now = new Date().toISOString();
  const user: User = {
    user_id: newUserId(),
    email: email.toLowerCase(),
    name: name.trim(),
    role,
    team: team ?? null,
    agent_id: agent_id?.trim() || null,
    status: "active",
    created_at: now,
    created_by: req.user!.user_id,
    updated_at: now,
  };
  await putUser(user);
  logger.info(`User created: ${user.email} (${user.role}) by ${req.user!.email}`);
  res.status(201).json(user);
});

/** PATCH /api/users/:id — update a user within permission bounds. */
usersRouter.patch("/:id", requireRole("admin", "super_admin"), async (req, res) => {
  const target = await getUser(req.params.id);
  if (!target) return res.status(404).json({ message: "User not found." });

  if (!canManageUser(req.user!, "update", target.role, target.team)) {
    return res.status(403).json({ message: "You cannot modify this user." });
  }

  const patch = req.body as Partial<Pick<User, "name" | "role" | "team" | "agent_id" | "status">>;

  // Admins cannot change role or team — only super_admins re-assign those.
  if (req.user!.role === "admin" && (patch.role !== undefined || patch.team !== undefined)) {
    return res.status(403).json({ message: "Only a super_admin can change role or team." });
  }
  if (patch.role && !ROLES.includes(patch.role)) {
    return res.status(400).json({ message: "Invalid role." });
  }
  if (patch.team && !TEAMS.includes(patch.team)) {
    return res.status(400).json({ message: "Invalid team." });
  }

  const updated = await updateUser(target.user_id, patch);
  logger.info(`User updated: ${target.email} by ${req.user!.email}`);
  res.json(updated);
});

/** DELETE /api/users/:id — remove a user (RBAC enforced; protects last super_admin). */
usersRouter.delete("/:id", requireRole("admin", "super_admin"), async (req, res) => {
  const target = await getUser(req.params.id);
  if (!target) return res.status(404).json({ message: "User not found." });

  if (target.user_id === req.user!.user_id) {
    return res.status(400).json({ message: "You cannot delete your own account." });
  }
  if (!canManageUser(req.user!, "delete", target.role, target.team)) {
    return res.status(403).json({ message: "You cannot delete this user." });
  }
  if (target.role === "super_admin") {
    const supers = (await listUsers()).filter((u) => u.role === "super_admin");
    if (supers.length <= 1) {
      return res.status(400).json({ message: "Cannot delete the last super_admin." });
    }
  }

  await deleteUser(target.user_id);
  logger.info(`User deleted: ${target.email} by ${req.user!.email}`);
  res.json({ ok: true });
});
