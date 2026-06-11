import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/aws.js";
import { env } from "../env.js";
import type { Feedback, Team } from "../types.js";

const TABLE = env.DDB_FEEDBACK_TABLE;

export function newFeedbackId(): string {
  const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `FB-${rand}`;
}

export async function getFeedback(feedbackId: string): Promise<Feedback | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { feedback_id: feedbackId } }));
  return (res.Item as Feedback) ?? null;
}

/** All feedback for a single audited call (via the audit-index GSI). */
export async function listFeedbackByAudit(auditId: string): Promise<Feedback[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "audit-index",
      KeyConditionExpression: "audit_id = :a",
      ExpressionAttributeValues: { ":a": auditId },
    })
  );
  return (res.Items as Feedback[]) ?? [];
}

/**
 * Recent feedback for a team, newest first (via the team-index GSI sorted on
 * created_at). `limit` caps how much is pulled for the suggestion analysis.
 */
export async function listFeedbackByTeam(teamId: Team, limit = 200): Promise<Feedback[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "team-index",
      KeyConditionExpression: "team = :t",
      ExpressionAttributeValues: { ":t": teamId },
      ScanIndexForward: false, // newest first
      Limit: limit,
    })
  );
  return (res.Items as Feedback[]) ?? [];
}

export async function putFeedback(feedback: Feedback): Promise<Feedback> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: feedback }));
  return feedback;
}

export async function deleteFeedback(feedbackId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { feedback_id: feedbackId } }));
}
