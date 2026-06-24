import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type LoginBreakdownResponse,
  type LoginGranularity,
  type LoginTeamsResponse,
  type User,
} from "@/lib/cx-data";
import { fetchLoginBreakdown, fetchLoginTeams } from "@/lib/api";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";

const GRANULARITIES: LoginGranularity[] = ["day", "month"];

/**
 * Super-admin view of who is opening the dashboard. "By team" answers how many
 * teams are active and how often each signs in; "By role" splits admins vs
 * users vs super-admins. Counts come from the /login-stats API.
 */
export function SignInActivityView({ user }: { user: User }) {
  const [granularity, setGranularity] = useState<LoginGranularity>("day");
  const [mode, setMode] = useState<"team" | "role">("team");

  // Defensive: this view is only mounted for super_admins, but never call the
  // super-admin-only endpoints for anyone else.
  const enabled = user.role === "super_admin";

  return (
    <div className="p-6 space-y-6 max-w-5xl">
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
              {g === "day" ? "Daily" : "Monthly"}
            </button>
          ))}
        </div>
        <div className="flex border border-border rounded-sm overflow-hidden">
          {(["team", "role"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
                mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-surface-2"
              )}
            >
              {m === "team" ? "By team" : "By role"}
            </button>
          ))}
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {mode === "team" ? "Teams opening the dashboard" : "Sign-ins by role"}
        </span>
      </div>

      {mode === "team" ? (
        <TeamActivity granularity={granularity} enabled={enabled} />
      ) : (
        <RoleActivity granularity={granularity} enabled={enabled} />
      )}
    </div>
  );
}

function TeamActivity({ granularity, enabled }: { granularity: LoginGranularity; enabled: boolean }) {
  const { data, isLoading } = useQuery<LoginTeamsResponse>({
    queryKey: ["login-teams", granularity],
    queryFn: () => fetchLoginTeams(granularity),
    enabled,
  });

  // One bar per team for the most recent period in range.
  const latestPeriod = data?.latest_period ?? null;
  const chart = useMemo(
    () =>
      (data?.teams ?? [])
        .map((t) => {
          const point = latestPeriod ? t.series.find((p) => p.period === latestPeriod) : undefined;
          return { name: t.name, logins: point?.login_count ?? 0, unique: point?.unique_count ?? 0 };
        })
        .sort((a, b) => b.logins - a.logins),
    [data, latestPeriod]
  );

  const latestLogins = chart.reduce((s, r) => s + r.logins, 0);
  const latestUnique = chart.reduce((s, r) => s + r.unique, 0); // a user belongs to one team → no double count

  if (isLoading) return <div className="font-mono text-xs text-muted-foreground">Loading…</div>;

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Teams active" value={`${data?.active_teams ?? 0} / ${data?.total_teams ?? 0}`} />
        <Stat label={`Sign-ins (${granularity})`} value={latestLogins} />
        <Stat label="Unique users" value={latestUnique} />
        <Stat label="Latest period" value={latestPeriod ?? "—"} />
      </div>

      {chart.length === 0 ? (
        <Empty />
      ) : (
        <>
          <ChartCard title={`Sign-ins per team · ${latestPeriod ?? "latest"}`}>
            <ResponsiveContainer width="100%" height={Math.max(200, chart.length * 38)}>
              <BarChart data={chart} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} />
                <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", fontSize: 12 }} />
                <Bar dataKey="logins" name="Sign-ins" fill="var(--teal)" radius={[0, 2, 2, 0]} />
                <Bar dataKey="unique" name="Unique users" fill="var(--primary)" radius={[0, 2, 2, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Per-team detail">
            <table className="w-full text-sm">
              <thead>
                <tr className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground text-left">
                  <th className="py-2">Team</th>
                  <th className="py-2 text-right">Sign-ins ({latestPeriod ?? "latest"})</th>
                  <th className="py-2 text-right">Unique</th>
                  <th className="py-2 text-right">Total sign-ins (range)</th>
                </tr>
              </thead>
              <tbody>
                {(data?.teams ?? [])
                  .slice()
                  .sort((a, b) => b.summary.latest_logins - a.summary.latest_logins)
                  .map((t) => (
                    <tr key={t.team_id} className="border-t border-border">
                      <td className="py-2">{t.name}</td>
                      <td className="py-2 text-right tabular-nums">{t.summary.latest_logins}</td>
                      <td className="py-2 text-right tabular-nums">{t.summary.latest_unique}</td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">{t.summary.total_logins}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </ChartCard>
        </>
      )}
    </>
  );
}

function RoleActivity({ granularity, enabled }: { granularity: LoginGranularity; enabled: boolean }) {
  const { data, isLoading } = useQuery<LoginBreakdownResponse>({
    queryKey: ["login-breakdown", granularity],
    queryFn: () => fetchLoginBreakdown(granularity),
    enabled,
  });

  const byScope = (s: string) => data?.breakdown.find((b) => b.scope === s);
  const all = byScope("all");
  const admins = byScope("admin");
  const users = byScope("user");

  // Merge admin + user unique counts onto a shared period axis for the chart.
  const chart = useMemo(() => {
    const periods = new Set<string>();
    (admins?.series ?? []).forEach((p) => periods.add(p.period));
    (users?.series ?? []).forEach((p) => periods.add(p.period));
    return [...periods]
      .sort()
      .map((period) => ({
        period,
        admins: admins?.series.find((p) => p.period === period)?.unique_count ?? 0,
        users: users?.series.find((p) => p.period === period)?.unique_count ?? 0,
      }));
  }, [admins, users]);

  if (isLoading) return <div className="font-mono text-xs text-muted-foreground">Loading…</div>;

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Admins active" value={admins?.summary.latest_unique ?? 0} />
        <Stat label="Users active" value={users?.summary.latest_unique ?? 0} />
        <Stat label={`Total sign-ins (${granularity})`} value={all?.summary.latest_logins ?? 0} />
        <Stat label="Latest period" value={all?.summary.latest_period ?? "—"} />
      </div>

      {chart.length === 0 ? (
        <Empty />
      ) : (
        <ChartCard title="Unique users signing in over time">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chart} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="period" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
              <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", fontSize: 12 }} />
              <Line type="monotone" dataKey="admins" name="Admins" stroke="var(--primary)" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="users" name="Users" stroke="var(--teal)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </>
  );
}

function Empty() {
  return (
    <div className="border border-border bg-surface rounded-md p-12 text-center font-mono text-xs text-muted-foreground">
      No sign-ins recorded in this range yet.
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-border bg-surface rounded-md p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold mt-1 tabular-nums">{value}</div>
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
