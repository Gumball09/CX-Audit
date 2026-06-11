import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/aws.js";
import { env } from "../env.js";
import type { User } from "../types.js";

const TABLE = env.DDB_USERS_TABLE;

/** Generate a random user id (no external uuid dependency). */
export function newUserId(): string {
  const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `USR-${rand}`;
}

/**
 * `agent_id` is the hash key of the agent-index GSI, and DynamoDB forbids a NULL
 * value on a GSI key attribute. Users without a dialer agent (e.g. super_admins)
 * must therefore OMIT the attribute entirely, keeping the index sparse.
 */
function toItem(user: User): Record<string, unknown> {
  const item: Record<string, unknown> = { ...user, email: user.email.toLowerCase() };
  if (item.agent_id == null) delete item.agent_id;
  return item;
}

/** Restore the API contract (agent_id/team are `null`, never `undefined`). */
function fromItem(item: Record<string, unknown> | undefined): User | null {
  if (!item) return null;
  return { ...(item as unknown as User), agent_id: (item.agent_id as string) ?? null, team: (item.team as string) ?? null };
}

export async function getUser(userId: string): Promise<User | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { user_id: userId } }));
  return fromItem(res.Item);
}

/** Look up by email via the email-index GSI (used for login). */
export async function getUserByEmail(email: string): Promise<User | null> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "email-index",
      KeyConditionExpression: "email = :e",
      ExpressionAttributeValues: { ":e": email.toLowerCase() },
      Limit: 1,
    })
  );
  return fromItem(res.Items?.[0]);
}

/** Look up by dialer agent_id via the agent-index GSI (used during auditing). */
export async function getUserByAgentId(agentId: string): Promise<User | null> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "agent-index",
      KeyConditionExpression: "agent_id = :a",
      ExpressionAttributeValues: { ":a": agentId },
      Limit: 1,
    })
  );
  return fromItem(res.Items?.[0]);
}

export async function listUsers(): Promise<User[]> {
  const res = await ddb.send(new ScanCommand({ TableName: TABLE }));
  return ((res.Items as Record<string, unknown>[]) ?? []).map((i) => fromItem(i)!);
}

export async function putUser(user: User): Promise<User> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: toItem(user) }));
  return user;
}

/** Set (or replace) a user's bcrypt password hash. Returns the updated row. */
export async function setUserPassword(userId: string, passwordHash: string): Promise<User | null> {
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { user_id: userId },
      UpdateExpression: "SET password_hash = :p, updated_at = :u",
      ExpressionAttributeValues: { ":p": passwordHash, ":u": new Date().toISOString() },
      ConditionExpression: "attribute_exists(user_id)",
      ReturnValues: "ALL_NEW",
    })
  );
  return (res.Attributes as User) ?? null;
}

export async function updateUser(
  userId: string,
  patch: Partial<Pick<User, "name" | "role" | "team" | "agent_id" | "status">>
): Promise<User | null> {
  const sets: string[] = ["updated_at = :u"];
  const removes: string[] = [];
  const values: Record<string, unknown> = { ":u": new Date().toISOString() };
  const names: Record<string, string> = {};

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    names[`#${k}`] = k;
    // agent_id is a GSI key: clearing it must REMOVE the attribute (no NULL key).
    if (k === "agent_id" && v == null) {
      removes.push(`#${k}`);
      continue;
    }
    sets.push(`#${k} = :${k}`);
    values[`:${k}`] = v;
  }

  const expr = `SET ${sets.join(", ")}` + (removes.length ? ` REMOVE ${removes.join(", ")}` : "");
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { user_id: userId },
      UpdateExpression: expr,
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(user_id)",
      ReturnValues: "ALL_NEW",
    })
  );
  return fromItem(res.Attributes);
}

export async function deleteUser(userId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { user_id: userId } }));
}
