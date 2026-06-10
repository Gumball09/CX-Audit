import { GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/aws.js";
import { env } from "../env.js";
import type { Team, TeamRubric } from "../types.js";

const TABLE = env.DDB_TEAMS_TABLE;

export async function getTeam(teamId: Team): Promise<TeamRubric | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { team_id: teamId } }));
  return (res.Item as TeamRubric) ?? null;
}

export async function listTeams(): Promise<TeamRubric[]> {
  const res = await ddb.send(new ScanCommand({ TableName: TABLE }));
  return (res.Items as TeamRubric[]) ?? [];
}

export async function putTeam(team: TeamRubric): Promise<TeamRubric> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: team }));
  return team;
}
