import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type Audit,
  type User,
  TEAMS,
  type Team,
  canSeeAdmin,
  scoreColor,
  statusClass,
  teamClass,
} from "@/lib/cx-data";
import { fetchAudits, fetchTranscript, reauditCall, type AuditFilters } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ChevronDown, ChevronRight, Download, ExternalLink, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

export function CallAuditsView({ user, users }: { user: User; users: User[] }) {
  const [team, setTeam] = useState<Team | "All">("All");
  const [agentQ, setAgentQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [selected, setSelected] = useState<Audit | null>(null);

  const filters: AuditFilters = {
    team,
    flagged: flaggedOnly,
    from: from ? `${from}T00:00:00.000Z` : undefined,
    to: to ? `${to}T23:59:59.999Z` : undefined,
  };

  const { data: audits = [], isLoading } = useQuery<Audit[]>({
    queryKey: ["audits", filters],
    queryFn: () => fetchAudits(filters),
  });

  const userByAgent = useMemo(
    () => Object.fromEntries(users.filter((u) => u.agent_id).map((u) => [u.agent_id!, u])),
    [users]
  );
  const agentName = (agentId: string) => userByAgent[agentId]?.name ?? agentId;

  const filtered = audits.filter((a) => {
    if (!agentQ) return true;
    const q = agentQ.toLowerCase();
    return a.agent_id.includes(q) || agentName(a.agent_id).toLowerCase().includes(q);
  });

  const exportCsv = () => {
    const rows = [
      ["audit_id", "agent", "team", "campaign", "customer", "call_datetime", "status", "score", "flagged", "flag_reason"],
      ...filtered.map((a) => [
        a.audit_id,
        agentName(a.agent_id),
        a.team ?? "",
        a.campaign,
        a.customer_number,
        a.call_datetime,
        a.status,
        a.score ?? "",
        a.flagged ? "yes" : "no",
        `"${(a.flag_reason ?? "").replace(/"/g, '""')}"`,
      ]),
    ];
    const blob = new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "call_audits.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-end gap-3 mb-6">
        <Field label="Team">
          <Select value={team} onValueChange={(v) => setTeam(v as Team | "All")}>
            <SelectTrigger className="w-[160px] bg-surface border-border font-mono text-xs h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All</SelectItem>
              {TEAMS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px] bg-surface border-border font-mono text-xs h-9" />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px] bg-surface border-border font-mono text-xs h-9" />
        </Field>
        <Field label="Agent" className="flex-1 min-w-[200px]">
          <Input value={agentQ} onChange={(e) => setAgentQ(e.target.value)} placeholder="Search by agent id or name" className="bg-surface border-border font-mono text-xs h-9" />
        </Field>
        <div className="flex items-center gap-2 h-9">
          <Switch checked={flaggedOnly} onCheckedChange={setFlaggedOnly} id="flagged" />
          <label htmlFor="flagged" className="font-mono text-xs text-muted-foreground cursor-pointer">Flagged only</label>
        </div>
        <Button variant="ghost" onClick={exportCsv} className="font-mono text-xs h-9 border border-border hover:bg-surface-2">
          <Download className="h-3.5 w-3.5 mr-1.5" /> Export CSV
        </Button>
      </div>

      <div className="border border-border rounded-md overflow-hidden bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-background">
              {["#", "Agent", "Team", "Campaign", "Call Time", "Status", "Flag Reason", "Score"].map((h) => (
                <th key={h} className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground text-left px-3 py-2.5 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={8} className="px-3 py-12 text-center font-mono text-xs text-muted-foreground">Loading audits…</td></tr>
            )}
            {!isLoading && filtered.map((a, i) => (
              <tr key={a.audit_id} onClick={() => setSelected(a)} className="border-b border-border last:border-0 cursor-pointer hover:bg-surface-2 transition-colors duration-100">
                <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{i + 1}</td>
                <td className="px-3 py-3">
                  <div className="text-foreground">{agentName(a.agent_id)}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{a.agent_id}</div>
                </td>
                <td className="px-3 py-3">
                  <span className={cn("font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-sm", teamClass(a.team))}>{a.team ?? "—"}</span>
                </td>
                <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{a.campaign}</td>
                <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{new Date(a.call_datetime).toLocaleString()}</td>
                <td className="px-3 py-3">
                  <span className={cn("font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-sm", statusClass(a.status))}>{a.status}</span>
                </td>
                <td className="px-3 py-3 text-xs text-muted-foreground">
                  <span className="line-clamp-1 max-w-[280px] inline-block align-middle">{a.flag_reason ?? "—"}</span>
                </td>
                <td className="px-3 py-3">
                  <span className={cn("font-mono text-xs px-2 py-0.5 border rounded-sm inline-block min-w-[36px] text-center", scoreColor(a.score))}>{a.score ?? "—"}</span>
                </td>
              </tr>
            ))}
            {!isLoading && filtered.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-12 text-center font-mono text-xs text-muted-foreground">No audits match the current filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <AuditDrawer audit={selected} agentName={selected ? agentName(selected.agent_id) : ""} canReaudit={canSeeAdmin(user.role)} onClose={() => setSelected(null)} />
    </div>
  );
}

function AuditDrawer({ audit, agentName, canReaudit, onClose }: { audit: Audit | null; agentName: string; canReaudit: boolean; onClose: () => void }) {
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: transcriptData, isLoading: transcriptLoading } = useQuery({
    queryKey: ["transcript", audit?.audit_id],
    queryFn: () => fetchTranscript(audit!.audit_id),
    enabled: !!audit && transcriptOpen && !!audit.transcription_key,
  });

  const reaudit = useMutation({
    mutationFn: () => reauditCall(audit!.audit_id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["audits"] }),
  });

  return (
    <Sheet open={!!audit} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[480px] sm:max-w-[480px] bg-surface border-l border-border p-0 overflow-y-auto">
        {audit && (
          <>
            <SheetHeader className="px-6 py-4 border-b border-border">
              <SheetTitle className="font-mono text-xs text-muted-foreground">{audit.audit_id}</SheetTitle>
              <div className="text-foreground text-base font-semibold">{agentName}</div>
              <div className="font-mono text-xs text-muted-foreground">
                {audit.team ?? "Unmapped team"} · {new Date(audit.call_datetime).toLocaleString()}
              </div>
            </SheetHeader>

            <section className="px-6 py-4 border-b border-border space-y-2">
              <Meta label="Status" value={audit.status} />
              <Meta label="Campaign" value={audit.campaign} />
              <Meta label="Customer" value={audit.customer_number} />
              <Meta label="Score" value={audit.score !== undefined ? String(audit.score) : "—"} />
              {audit.recording_url && (
                <a href={audit.recording_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[11px] text-primary hover:underline">
                  <ExternalLink className="h-3 w-3" /> recording
                </a>
              )}
            </section>

            {audit.error && (
              <section className="px-6 py-4 border-b border-border">
                <div className="border-l-2 border-destructive bg-background p-3 rounded-r-sm text-sm text-destructive">{audit.error}</div>
              </section>
            )}

            {audit.flag_reason && (
              <section className="px-6 py-4 border-b border-border">
                <h3 className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-3">Flag Summary</h3>
                <div className="border-l-2 border-primary bg-background p-3 rounded-r-sm text-sm text-foreground">{audit.flag_reason}</div>
              </section>
            )}

            {audit.criteria_scores && audit.criteria_scores.length > 0 && (
              <section className="px-6 py-4 border-b border-border">
                <h3 className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-3">Audit Breakdown</h3>
                <ul className="space-y-3">
                  {audit.criteria_scores.map((c) => (
                    <li key={c.name} className="border border-border rounded-md p-3 bg-background">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">{c.name}</span>
                        <span className={cn("font-mono text-xs px-2 py-0.5 border rounded-sm", scoreColor(c.score))}>{c.score}</span>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">{c.explanation}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {audit.transcription_key && (
              <section className="px-6 py-4 border-b border-border">
                <button onClick={() => setTranscriptOpen((o) => !o)} className="flex items-center gap-2 w-full text-left">
                  {transcriptOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  <h3 className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Full Transcript</h3>
                </button>
                {transcriptOpen && (
                  <pre className="font-mono text-xs text-foreground/90 bg-background border border-border rounded-md p-3 mt-3 whitespace-pre-wrap leading-relaxed">
                    {transcriptLoading ? "Loading…" : transcriptData?.transcript ?? "Unavailable."}
                  </pre>
                )}
              </section>
            )}

            {canReaudit && (
              <footer className="px-6 py-4 flex gap-2 sticky bottom-0 bg-surface border-t border-border">
                <Button
                  onClick={() => reaudit.mutate()}
                  disabled={reaudit.isPending || !audit.transcription_key}
                  className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", reaudit.isPending && "animate-spin")} />
                  {reaudit.isPending ? "Re-queuing…" : "Re-run Audit"}
                </Button>
              </footer>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="font-mono text-xs text-foreground">{value}</span>
    </div>
  );
}
