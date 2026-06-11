import { query, queryOne, execute } from "../lib/db.js";
import type { User } from "../types.js";

/** Generate a random user id (no external uuid dependency). */
export function newUserId(): string {
  const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `USR-${rand}`;
}

export async function getUser(userId: string): Promise<User | null> {
  return queryOne<User>("SELECT * FROM cx_users WHERE user_id = $1", [userId]);
}

/** Look up by email (used for login). */
export async function getUserByEmail(email: string): Promise<User | null> {
  return queryOne<User>("SELECT * FROM cx_users WHERE email = $1", [email.toLowerCase()]);
}

/** Look up by dialer agent_id (used during auditing). */
export async function getUserByAgentId(agentId: string): Promise<User | null> {
  return queryOne<User>("SELECT * FROM cx_users WHERE agent_id = $1 LIMIT 1", [agentId]);
}

export async function listUsers(): Promise<User[]> {
  return query<User>("SELECT * FROM cx_users ORDER BY created_at DESC");
}

export async function putUser(user: User): Promise<User> {
  await execute(
    `INSERT INTO cx_users
       (user_id, email, name, role, team, agent_id, status, created_at, created_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (user_id) DO UPDATE SET
       email = EXCLUDED.email, name = EXCLUDED.name, role = EXCLUDED.role,
       team = EXCLUDED.team, agent_id = EXCLUDED.agent_id, status = EXCLUDED.status,
       created_at = EXCLUDED.created_at, created_by = EXCLUDED.created_by,
       updated_at = EXCLUDED.updated_at`,
    [
      user.user_id, user.email.toLowerCase(), user.name, user.role, user.team,
      user.agent_id, user.status, user.created_at, user.created_by, user.updated_at,
    ]
  );
  return user;
}

export async function updateUser(
  userId: string,
  patch: Partial<Pick<User, "name" | "role" | "team" | "agent_id" | "status">>
): Promise<User | null> {
  const sets: string[] = ["updated_at = $1"];
  const values: unknown[] = [new Date().toISOString()];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    values.push(v);
    sets.push(`${k} = $${values.length}`);
  }
  values.push(userId);
  return queryOne<User>(
    `UPDATE cx_users SET ${sets.join(", ")} WHERE user_id = $${values.length} RETURNING *`,
    values
  );
}

export async function deleteUser(userId: string): Promise<void> {
  await execute("DELETE FROM cx_users WHERE user_id = $1", [userId]);
}
