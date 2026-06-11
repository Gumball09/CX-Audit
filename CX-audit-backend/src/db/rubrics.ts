import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/aws.js";
import { env } from "../env.js";
import type { Rubric, Team } from "../types.js";

const TABLE = env.DDB_RUBRICS_TABLE;

export function newRubricId(): string {
  const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `RUB-${rand}`;
}

export async function getRubric(rubricId: string): Promise<Rubric | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { rubric_id: rubricId } }));
  return (res.Item as Rubric) ?? null;
}

/** All additional rubrics for a team (via the team-index GSI). */
export async function listRubricsByTeam(teamId: Team): Promise<Rubric[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "team-index",
      KeyConditionExpression: "team_id = :t",
      ExpressionAttributeValues: { ":t": teamId },
    })
  );
  return (res.Items as Rubric[]) ?? [];
}

export async function putRubric(rubric: Rubric): Promise<Rubric> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: rubric }));
  return rubric;
}

export async function deleteRubric(rubricId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { rubric_id: rubricId } }));
}

export async function updateRubricFields(
  rubricId: string,
  patch: Partial<Pick<Rubric, "name" | "description" | "criteria" | "system_prompt" | "scale_max" | "flag_threshold" | "critical_criterion_threshold" | "active">>,
  updatedBy: string | null
): Promise<Rubric | null> {
  const sets: string[] = ["updated_at = :u", "updated_by = :ub"];
  const values: Record<string, unknown> = { ":u": new Date().toISOString(), ":ub": updatedBy };
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
      Key: { rubric_id: rubricId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(rubric_id)",
      ReturnValues: "ALL_NEW",
    })
  );
  return (res.Attributes as Rubric) ?? null;
}
