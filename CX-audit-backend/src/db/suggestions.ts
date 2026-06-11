import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/aws.js";
import { env } from "../env.js";
import type { RubricSuggestion, SuggestionStatus, Team } from "../types.js";

const TABLE = env.DDB_SUGGESTIONS_TABLE;

export function newSuggestionId(): string {
  const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `SUG-${rand}`;
}

export async function getSuggestion(suggestionId: string): Promise<RubricSuggestion | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { suggestion_id: suggestionId } }));
  return (res.Item as RubricSuggestion) ?? null;
}

/** Suggestions for a team, newest first (via the team-index GSI). */
export async function listSuggestionsByTeam(teamId: Team, limit = 50): Promise<RubricSuggestion[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "team-index",
      KeyConditionExpression: "team = :t",
      ExpressionAttributeValues: { ":t": teamId },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  return (res.Items as RubricSuggestion[]) ?? [];
}

export async function putSuggestion(suggestion: RubricSuggestion): Promise<RubricSuggestion> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: suggestion }));
  return suggestion;
}

export async function deleteSuggestion(suggestionId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { suggestion_id: suggestionId } }));
}

export async function setSuggestionStatus(
  suggestionId: string,
  status: SuggestionStatus,
  updatedBy: string | null
): Promise<RubricSuggestion | null> {
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { suggestion_id: suggestionId },
      UpdateExpression: "SET #s = :s, updated_at = :u, updated_by = :ub",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": status, ":u": new Date().toISOString(), ":ub": updatedBy },
      ConditionExpression: "attribute_exists(suggestion_id)",
      ReturnValues: "ALL_NEW",
    })
  );
  return (res.Attributes as RubricSuggestion) ?? null;
}
