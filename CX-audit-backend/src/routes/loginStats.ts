import { Router } from "express";
import { requireRole } from "../services/auth.js";
import { getLoginStatsSeries } from "../db/loginStats.js";
import { listTeams } from "../db/teams.js";
import type { LoginGranularity, LoginRoleScope, LoginStatPoint } from "../types.js";

export const loginStatsRouter = Router();

const GRANULARITIES: LoginGranularity[] = ["day", "month"];
const ROLE_SCOPES: LoginRoleScope[] = ["all", "super_admin", "admin", "user"];

function parseGranularity(v: unknown): LoginGranularity {
  return GRANULARITIES.includes(v as LoginGranularity) ? (v as LoginGranularity) : "day";
}
function parseRoleScope(v: unknown): LoginRoleScope {
  return ROLE_SCOPES.includes(v as LoginRoleScope) ? (v as LoginRoleScope) : "all";
}

/** Roll a series into headline numbers + a delta vs the previous period. */
function summarize(series: LoginStatPoint[]) {
  const total_logins = series.reduce((s, p) => s + p.login_count, 0);
  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  return {
    total_logins,
    periods: series.length,
    latest_period: latest?.period ?? null,
    latest_logins: latest?.login_count ?? 0,
    latest_unique: latest?.unique_count ?? 0,
    unique_delta: latest && previous ? latest.unique_count - previous.unique_count : null,
  };
}

// Sign-in analytics are org-wide and sensitive → super_admin only.
loginStatsRouter.use(requireRole("super_admin"));

/**
 * GET /api/login-stats?scope=all|admin|user|super_admin&granularity=day|month&from&to
 * Sign-in time series for one role scope.
 */
loginStatsRouter.get("/", async (req, res) => {
  const { scope, granularity, from, to } = req.query as Record<string, string>;
  const sc = parseRoleScope(scope);
  const g = parseGranularity(granularity);
  const series = await getLoginStatsSeries("role", sc, g, from || undefined, to || undefined);
  res.json({ scope: sc, granularity: g, series, summary: summarize(series) });
});

/**
 * GET /api/login-stats/breakdown?granularity=day|month&from&to
 * Parallel series for admins, users, super_admins, and the "all" rollup —
 * one call for the role-axis dashboard.
 */
loginStatsRouter.get("/breakdown", async (req, res) => {
  const { granularity, from, to } = req.query as Record<string, string>;
  const g = parseGranularity(granularity);
  const series = await Promise.all(
    ROLE_SCOPES.map((sc) => getLoginStatsSeries("role", sc, g, from || undefined, to || undefined))
  );
  const breakdown = ROLE_SCOPES.map((scope, i) => ({
    scope,
    series: series[i],
    summary: summarize(series[i]),
  }));
  res.json({ granularity: g, breakdown });
});

/**
 * GET /api/login-stats/teams?granularity=day|month&from&to
 * Per-team sign-in series, plus how many teams are actively opening the
 * dashboard (had ≥1 sign-in in the latest period in range).
 */
loginStatsRouter.get("/teams", async (req, res) => {
  const { granularity, from, to } = req.query as Record<string, string>;
  const g = parseGranularity(granularity);

  const allTeams = await listTeams();
  const series = await Promise.all(
    allTeams.map((t) => getLoginStatsSeries("team", t.team_id, g, from || undefined, to || undefined))
  );

  const teams = allTeams.map((t, i) => ({
    team_id: t.team_id,
    name: t.name ?? t.team_id,
    series: series[i],
    summary: summarize(series[i]),
  }));

  // "Active" = the team signed in during the most recent period present in range.
  const latest_period = teams
    .map((t) => t.summary.latest_period)
    .filter((p): p is string => !!p)
    .sort()
    .pop() ?? null;
  const active_teams = latest_period
    ? teams.filter((t) => t.summary.latest_period === latest_period && t.summary.latest_logins > 0).length
    : 0;

  res.json({
    granularity: g,
    total_teams: allTeams.length,
    active_teams,
    latest_period,
    teams,
  });
});
