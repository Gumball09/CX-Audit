import { query, queryOne, execute } from "../lib/db.js";
import type { Team, TeamRubric } from "../types.js";

export async function getTeam(teamId: Team): Promise<TeamRubric | null> {
  return queryOne<TeamRubric>("SELECT * FROM cx_teams WHERE team_id = $1", [teamId]);
}

export async function listTeams(): Promise<TeamRubric[]> {
  return query<TeamRubric>("SELECT * FROM cx_teams ORDER BY team_id");
}

export async function putTeam(team: TeamRubric): Promise<TeamRubric> {
  await execute(
    `INSERT INTO cx_teams
       (team_id, name, description, criteria, system_prompt, scale_max,
        flag_threshold, critical_criterion_threshold, updated_at, updated_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (team_id) DO UPDATE SET
       name = EXCLUDED.name, description = EXCLUDED.description, criteria = EXCLUDED.criteria,
       system_prompt = EXCLUDED.system_prompt, scale_max = EXCLUDED.scale_max,
       flag_threshold = EXCLUDED.flag_threshold,
       critical_criterion_threshold = EXCLUDED.critical_criterion_threshold,
       updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [
      team.team_id, team.name, team.description, JSON.stringify(team.criteria),
      team.system_prompt, team.scale_max ?? null, team.flag_threshold,
      team.critical_criterion_threshold, team.updated_at, team.updated_by,
    ]
  );
  return team;
}
