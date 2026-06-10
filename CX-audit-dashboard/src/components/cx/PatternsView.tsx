import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { type RecordingPattern, type User } from "@/lib/cx-data";
import { fetchPatterns, createPattern, updatePattern, deletePattern, testPattern } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Super-admin view for managing the recording-filename regex patterns. Patterns
 * are tried in priority order; the lowest-priority one is the active "default".
 * The backend auto-promotes the most-used pattern to default over time, so this
 * screen surfaces match counts to make that visible.
 */
export function PatternsView({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const isSuper = user.role === "super_admin";
  const { data: patterns = [], isLoading } = useQuery<RecordingPattern[]>({
    queryKey: ["patterns"],
    queryFn: fetchPatterns,
    enabled: isSuper,
  });

  const [label, setLabel] = useState("");
  const [regex, setRegex] = useState("");
  const [sample, setSample] = useState("");
  const [testResult, setTestResult] = useState<{ matched: boolean; groups: Record<string, string> | null } | null>(null);
  const [error, setError] = useState("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["patterns"] });

  const createMut = useMutation({
    mutationFn: () => createPattern({ label, regex }),
    onSuccess: () => { setLabel(""); setRegex(""); setSample(""); setTestResult(null); setError(""); invalidate(); },
    onError: (e) => setError(e instanceof Error ? e.message : "Create failed."),
  });
  const updateMut = useMutation({
    mutationFn: (v: { id: string; patch: Partial<RecordingPattern> }) => updatePattern(v.id, v.patch),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof Error ? e.message : "Update failed."),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deletePattern(id),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof Error ? e.message : "Delete failed."),
  });

  const runTest = async () => {
    setError("");
    try {
      setTestResult(await testPattern(regex, sample));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Test failed.");
    }
  };

  if (!isSuper) {
    return <div className="p-12 text-center font-mono text-xs text-muted-foreground">Recording patterns are managed by super admins.</div>;
  }

  const defaultId = patterns[0]?.pattern_id; // lowest priority = default

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <p className="font-mono text-xs text-muted-foreground">
        Patterns are tried top-to-bottom. The first whose <code className="text-foreground">(?&lt;agent_id&gt;…)</code> group matches wins.
        The most-used pattern is automatically promoted to the default — so when the dialer's link format changes, the new pattern takes over on its own.
      </p>

      {error && <div className="border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 rounded-sm font-mono text-xs">{error}</div>}

      {/* Existing patterns */}
      <div className="border border-border rounded-md overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-2 bg-surface font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Pattern</span><span>Priority</span><span>Matches</span><span>Active</span><span></span>
        </div>
        {isLoading && <div className="p-4 font-mono text-xs text-muted-foreground">Loading…</div>}
        {patterns.map((p) => (
          <div key={p.pattern_id} className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-3 border-t border-border items-center">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground flex items-center gap-2">
                {p.label}
                {p.pattern_id === defaultId && <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 border border-primary/40 text-primary rounded-sm">default</span>}
                {p.is_builtin && <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 border border-border text-muted-foreground rounded-sm">built-in</span>}
              </div>
              <code className="block font-mono text-[10px] text-muted-foreground truncate mt-0.5">{p.regex}</code>
            </div>
            <Input
              type="number"
              defaultValue={p.priority}
              onBlur={(e) => Number(e.target.value) !== p.priority && updateMut.mutate({ id: p.pattern_id, patch: { priority: Number(e.target.value) } })}
              className="bg-background border-border w-16 font-mono"
            />
            <span className="font-mono text-sm text-foreground tabular-nums w-12 text-right">{p.match_count}</span>
            <Switch checked={p.active} onCheckedChange={(v) => updateMut.mutate({ id: p.pattern_id, patch: { active: v } })} />
            <button
              disabled={p.is_builtin || deleteMut.isPending}
              onClick={() => deleteMut.mutate(p.pattern_id)}
              aria-label="Delete pattern"
              className="p-2 rounded-sm hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-30"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* Add new */}
      <div className="border border-border rounded-md p-4 space-y-3 bg-surface">
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Add pattern</div>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. New dialer 2026)" className="bg-background border-border" />
        <Input value={regex} onChange={(e) => setRegex(e.target.value)} placeholder="Regex with named groups, e.g. ^agent-(?<agent_id>\d+)-…" className="bg-background border-border font-mono text-xs" />
        <div className="flex gap-2">
          <Input value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Sample filename to test against" className="bg-background border-border font-mono text-xs flex-1" />
          <Button variant="ghost" onClick={runTest} disabled={!regex || !sample} className="border border-border font-mono text-xs">Test</Button>
        </div>
        {testResult && (
          <div className={cn("font-mono text-xs px-3 py-2 rounded-sm border", testResult.matched ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-[color:var(--escalations)]/40 bg-[color:var(--escalations)]/10 text-[color:var(--escalations)]")}>
            {testResult.matched ? `Matched · groups: ${JSON.stringify(testResult.groups)}` : "No match."}
          </div>
        )}
        <Button onClick={() => createMut.mutate()} disabled={!label || !regex || createMut.isPending} className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
          {createMut.isPending ? "Adding…" : "Add Pattern"}
        </Button>
      </div>
    </div>
  );
}
