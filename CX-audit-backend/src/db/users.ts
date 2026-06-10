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

export async function getUser(userId: string): Promise<User | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { user_id: userId } }));
  return (res.Item as User) ?? null;
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
  return (res.Items?.[0] as User) ?? null;
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
  return (res.Items?.[0] as User) ?? null;
}

export async function listUsers(): Promise<User[]> {
  const res = await ddb.send(new ScanCommand({ TableName: TABLE }));
  return (res.Items as User[]) ?? [];
}

export async function putUser(user: User): Promise<User> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...user, email: user.email.toLowerCase() } }));
  return user;
}

export async function updateUser(
  userId: string,
  patch: Partial<Pick<User, "name" | "role" | "team" | "agent_id" | "status">>
): Promise<User | null> {
  const sets: string[] = ["updated_at = :u"];
  const values: Record<string, unknown> = { ":u": new Date().toISOString() };
  const names: Record<string, string> = {};

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    values[`:${k}`] = v;
  }

  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { user_id: userId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(user_id)",
      ReturnValues: "ALL_NEW",
    })
  );
  return (res.Attributes as User) ?? null;
}

export async function deleteUser(userId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { user_id: userId } }));
}
