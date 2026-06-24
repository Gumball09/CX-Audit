import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type PerformanceGranularity,
  type PerformanceResponse,
  type StatusCountsResponse,
  type Team,
  type TeamRubric,
  type User,
} from "@/lib/cx-data";
import { fetchMyPerformance, fetchPerformance, fetchStatusCounts, fetchTeams } from "@/lib/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";

const GRANULARITIES: PerformanceGranularity[] = ["day", "month", "year"];

/**
 * Performance graphs. A plain `user` sees their own call scores over time; an
 * `admin` sees their whole team; a `super_admin` can switch between teams.
 */
export function PerformanceView({ user, users }: { user: User; users: User[] }) {
  const [granularity, setGranularity] = useState<PerformanceGranularity>("month");
  const isUser = user.role === "user";
  const [team, setTeam] = useState<Team>(user.team ?? "CS");
  const [mode, setMode] = useState<"team" | "agent">("team");
  const [agentId, setAgentId] = useState<string>("");
  const { data: teamList = [] } = useQuery<TeamRubric[]>({ queryKey: ["teams"], queryFn: fetchTeams, enabled: user.role === "super_admin" });

  // Agents available for the individual view: those carrying an agent_id in the
  // team in focus (super_admin → the selected team; admin → their own team).
  const agentUsers = useMemo(
    () => users.filter((u) => u.agent_id && (user.role === "super_admin" ? u.team === team : u.team === user.team)),
    [users, team, user.role, user.team]
  );
  const agentLabel = (id: string) => users.find((u) => u.agent_id === id)?.name ?? id;

  const wantAgent = !isUser && mode === "agent";
  const needAgent = wantAgent && !agentId; // individual mode but nothing picked yet

  const { data, isLoading } = useQuery<PerformanceResponse>({
    queryKey: ["performance", isUser ? "me" : mode, mode === "agent" ? agentId : team, granularity, user.role],
    enabled: !needAgent,
    queryFn: () => {
      if (wantAgent && agentId) return fetchPerformance("agent", agentId, granularity);
      if (isUser) return fetchMyPerformance(granularity);
      return user.role === "super_admin"
        ? fetchPerformance("team", team, granularity)
        : fetchMyPerformance(granularity); // admin team view via /me
    },
  });

  const series = data?.series ?? [];
  const summary = data?.summary;
  const delta = summary?.score_delta;

  // Resolve the same scope the chart is showing, for the call-outcome counts
  // (audited/skipped come from the audits table, not the perf aggregates).
  let countScope: "agent" | "team" | null = null;
  let countId: string | undefined;
  if (wantAgent && agentId) { countScope = "agent"; countId = agentId; }
  else if (isUser && user.agent_id) { countScope = "agent"; countId = user.agent_id; }
  else if (user.role === "super_admin") { countScope = "team"; countId = team; }
  else if (user.team) { countScope = "team"; countId = user.team; }
  else if (user.agent_id) { countScope = "agent"; countId = user.agent_id; }

  const { data: statusCounts } = useQuery<StatusCountsResponse>({
    queryKey: ["status-counts", countScope, countId, user.role],
    enabled: !needAgent && !!countScope && !!countId,
    queryFn: () => fetchStatusCounts(countScope!, countId!),
  });
  const audited = statusCounts?.counts.audited ?? summary?.total_calls ?? 0;
  const skipped = statusCounts?.counts.skipped ?? 0;

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex border border-border rounded-sm overflow-hidden">
          {GRANULARITIES.map((g) => (
            <button
              key={g}
              onClick={() => setGranularity(g)}
              className={cn(
                "px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
                granularity === g ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-surface-2"
              )}
            >
              {g}
            </button>
          ))}
        </div>
        {/* Team vs individual scope (admins+; plain users only ever see themselves) */}
        {!isUser && (
          <div className="flex border border-border rounded-sm overflow-hidden">
            {(["team", "agent"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  "px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
                  mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-surface-2"
                )}
              >
                {m === "team" ? "Team" : "Individual"}
              </button>
            ))}
          </div>
        )}
        {user.role === "super_admin" && (
          <Select value={team} onValueChange={(v) => { setTeam(v as Team); setAgentId(""); }}>
            <SelectTrigger className="w-40 bg-surface border-border"><SelectValue /></SelectTrigger>
            <SelectContent>
              {teamList.map((t) => <SelectItem key={t.team_id} value={t.team_id}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        {wantAgent && (
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger className="w-56 bg-surface border-border"><SelectValue placeholder="Select an agent" /></SelectTrigger>
            <SelectContent>
              {agentUsers.length === 0
                ? <div className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">No agents in this team</div>
                : agentUsers.map((u) => <SelectItem key={u.user_id} value={u.agent_id!}>{u.name} · {u.agent_id}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <span className="font-mono text-[10px] text-muted-foreground">
          {isUser ? "Your calls" : wantAgent ? (agentId ? `Agent ${agentLabel(agentId)}` : "Pick an agent") : `Team ${data?.scope?.id ?? team}`}
        </span>
      </div>

      {needAgent ? (
        <div className="border border-border bg-surface rounded-md p-12 text-center font-mono text-xs text-muted-foreground">
          Select an agent to view individual performance.
        </div>
      ) : (
        <>
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Audited" value={audited} />
        <Stat label="Skipped" value={skipped} />
        <Stat label="Avg score" value={summary?.avg_score ?? 0} />
        <Stat label="Flagged" value={summary?.total_flagged ?? 0} />
        <Stat
          label="Latest vs prev"
          value={delta === null || delta === undefined ? "—" : `${delta >= 0 ? "+" : ""}${delta}`}
          tone={delta == null ? "muted" : delta >= 0 ? "up" : "down"}
        />
      </div>

      {isLoading && <div className="font-mono text-xs text-muted-foreground">Loading…</div>}
      {!isLoading && series.length === 0 && (
        <div className="border border-border bg-surface rounded-md p-12 text-center font-mono text-xs text-muted-foreground">
          No audited calls in this range yet.
        </div>
      )}

      {series.length > 0 && (
        <>
          <ChartCard title="Average score over time">
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={series} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="scoreFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="period" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", fontSize: 12 }} />
                <Area type="monotone" dataKey="avg_score" stroke="var(--primary)" fill="url(#scoreFill)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Calls audited per period">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={series} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="period" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", fontSize: 12 }} />
                <Bar dataKey="call_count" fill="var(--teal)" radius={[2, 2, 0, 0]} />
                <Bar dataKey="flagged_count" fill="var(--escalations)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </>
      )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "muted" }: { label: string; value: string | number; tone?: "muted" | "up" | "down" }) {
  return (
    <div className="border border-border bg-surface rounded-md p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          "text-2xl font-bold mt-1 tabular-nums",
          tone === "up" && "text-emerald-400",
          tone === "down" && "text-[color:var(--escalations)]"
        )}
      >
        {value}
      </div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border bg-surface rounded-md p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-3">{title}</div>
      {children}
    </div>
  );
}
