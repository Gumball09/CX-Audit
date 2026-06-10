import { Router } from "express";
import { getPerformanceSeries } from "../db/performance.js";
import { getUserByAgentId } from "../db/users.js";
import type { PerformanceGranularity, PerformancePoint, PerformanceScopeType, User } from "../types.js";

export const performanceRouter = Router();

const GRANULARITIES: PerformanceGranularity[] = ["day", "month", "year"];

function parseGranularity(v: unknown): PerformanceGranularity {
  return GRANULARITIES.includes(v as PerformanceGranularity) ? (v as PerformanceGranularity) : "month";
}

/** Roll a series up into headline numbers + a delta vs the previous period. */
function summarize(series: PerformancePoint[]) {
  const total_calls = series.reduce((s, p) => s + p.call_count, 0);
  const total_flagged = series.reduce((s, p) => s + p.flagged_count, 0);
  const weightedScore = series.reduce((s, p) => s + p.avg_score * p.call_count, 0);
  const avg_score = total_calls > 0 ? Math.round(weightedScore / total_calls) : 0;
  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  return {
    total_calls,
    total_flagged,
    avg_score,
    latest_period: latest?.period ?? null,
    latest_avg_score: latest?.avg_score ?? null,
    latest_calls: latest?.call_count ?? 0,
    score_delta: latest && previous ? latest.avg_score - previous.avg_score : null,
  };
}

/**
 * Decide whether `actor` may read the requested scope.
 *  - super_admin: anything.
 *  - admin: their own team, or an agent that belongs to their team.
 *  - user: only their own agent.
 */
async function authorizeScope(actor: User, scopeType: PerformanceScopeType, scopeId: string): Promise<boolean> {
  if (actor.role === "super_admin") return true;
  if (actor.role === "admin") {
    if (scopeType === "team") return scopeId === actor.team;
    const agentUser = await getUserByAgentId(scopeId);
    return !!agentUser && agentUser.team === actor.team;
  }
  // plain user
  return scopeType === "agent" && scopeId === actor.agent_id;
}

/**
 * GET /api/performance/me?granularity=month
 * The caller's own performance: own agent series for users; own team series for
 * admins/super_admins (falling back to their agent series if they have one).
 */
performanceRouter.get("/me", async (req, res) => {
  const user = req.user!;
  const granularity = parseGranularity((req.query.granularity as string) || "month");

  let scopeType: PerformanceScopeType | null = null;
  let scopeId: string | null = null;
  if (user.role === "user" && user.agent_id) {
    scopeType = "agent";
    scopeId = user.agent_id;
  } else if (user.team) {
    scopeType = "team";
    scopeId = user.team;
  } else if (user.agent_id) {
    scopeType = "agent";
    scopeId = user.agent_id;
  }

  if (!scopeType || !scopeId) return res.json({ scope: null, granularity, series: [], summary: summarize([]) });

  const series = await getPerformanceSeries(scopeType, scopeId, granularity);
  res.json({ scope: { type: scopeType, id: scopeId }, granularity, series, summary: summarize(series) });
});

/**
 * GET /api/performance?scope=agent|team&id=<id>&granularity=day|month|year&from&to
 * Scoped performance series for a specific agent or team (RBAC-enforced).
 */
performanceRouter.get("/", async (req, res) => {
  const { scope, id, granularity, from, to } = req.query as Record<string, string>;
  const scopeType = scope === "team" ? "team" : scope === "agent" ? "agent" : null;
  if (!scopeType || !id) return res.status(400).json({ message: "scope (agent|team) and id are required." });

  if (!(await authorizeScope(req.user!, scopeType, id))) {
    return res.status(403).json({ message: "Out of scope." });
  }

  const g = parseGranularity(granularity);
  const series = await getPerformanceSeries(scopeType, id, g, from || undefined, to || undefined);
  res.json({ scope: { type: scopeType, id }, granularity: g, series, summary: summarize(series) });
});
