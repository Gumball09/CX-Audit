import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { type User, type Criterion, type Team, type TeamInfra, type TeamRubric } from "@/lib/cx-data";
import { fetchTeams, updateTeam, createTeam } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

// The per-team infra fields, with the env var they fall back to when left blank.
const INFRA_FIELDS: { key: keyof TeamInfra; label: string; numeric?: boolean }[] = [
  { key: "recording_bucket", label: "S3 recording bucket" },
  { key: "output_bucket", label: "S3 output (transcripts + audits) bucket" },
  { key: "transcription_queue_url", label: "SQS transcription queue URL" },
  { key: "audit_queue_url", label: "SQS audit queue URL" },
  { key: "batch_size", label: "SQS batch size", numeric: true },
  { key: "wait_time_seconds", label: "SQS wait time (s)", numeric: true },
  { key: "max_receive_count", label: "SQS max receive count", numeric: true },
  { key: "worker_concurrency", label: "Worker concurrency", numeric: true },
];

export function AuditPromptsView({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const isSuper = user.role === "super_admin";
  const { data: teams = [], isLoading } = useQuery<TeamRubric[]>({ queryKey: ["teams"], queryFn: fetchTeams });

  const [selectedId, setSelectedId] = useState<Team | null>(null);
  const [draft, setDraft] = useState<TeamRubric | null>(null);
  const [error, setError] = useState("");

  // New-team form (super_admin only).
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");

  const selected = teams.find((t) => t.team_id === selectedId) ?? teams[0] ?? null;

  useEffect(() => {
    if (selected && selected.team_id !== draft?.team_id) setDraft(selected);
  }, [selected, draft?.team_id]);

  const canEdit = (teamId: Team) => isSuper || (user.role === "admin" && user.team === teamId);
  const editable = draft ? canEdit(draft.team_id) : false;

  const weightTotal = draft?.criteria.reduce((s, c) => s + (Number(c.weight) || 0), 0) ?? 0;
  const sharePct = (w?: number) => {
    if (!draft || draft.criteria.length === 0) return 0;
    if (weightTotal <= 0) return Math.round(100 / draft.criteria.length);
    return Math.round(((Number(w) || 0) / weightTotal) * 100);
  };

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["teams"] });

  const saveMut = useMutation({
    mutationFn: (rubric: TeamRubric) => {
      const patch: Partial<TeamRubric> = {
        name: rubric.name,
        description: rubric.description,
        criteria: rubric.criteria,
        system_prompt: rubric.system_prompt,
        scale_max: rubric.scale_max,
        flag_threshold: rubric.flag_threshold,
        critical_criterion_threshold: rubric.critical_criterion_threshold,
      };
      if (isSuper) { patch.infra = rubric.infra; patch.active = rubric.active; } // infra is super_admin-only server-side
      return updateTeam(rubric.team_id, patch);
    },
    onSuccess: (updated) => { invalidate(); setDraft(updated); setError(""); },
    onError: (e) => setError(e instanceof Error ? e.message : "Save failed."),
  });

  const createMut = useMutation({
    mutationFn: () => createTeam({ team_id: newId.trim(), name: newName.trim() || newId.trim() }),
    onSuccess: (created) => {
      invalidate();
      setCreating(false); setNewId(""); setNewName("");
      setSelectedId(created.team_id); setDraft(created); setError("");
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Create failed."),
  });

  const updateCriterion = (i: number, patch: Partial<Criterion>) =>
    draft && setDraft({ ...draft, criteria: draft.criteria.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) });
  const addCriterion = () => draft && setDraft({ ...draft, criteria: [...draft.criteria, { name: "", weight: 0, description: "" }] });
  const removeCriterion = (i: number) => draft && setDraft({ ...draft, criteria: draft.criteria.filter((_, idx) => idx !== i) });
  const updateInfra = (k: keyof TeamInfra, v: string | number | undefined) =>
    draft && setDraft({ ...draft, infra: { ...(draft.infra ?? {}), [k]: v } });

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      <aside className="w-[300px] shrink-0 border-r border-border bg-surface flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Teams</span>
          {isSuper && (
            <button onClick={() => setCreating((v) => !v)} className="font-mono text-[10px] text-primary hover:underline flex items-center gap-1">
              <Plus className="h-3 w-3" /> New
            </button>
          )}
        </div>
        {creating && isSuper && (
          <div className="p-3 border-b border-border space-y-2 bg-surface-2">
            <Input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="team id (e.g. Sales)" className="bg-background border-border font-mono text-xs h-8" />
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="display name" className="bg-background border-border text-xs h-8" />
            <div className="flex gap-2">
              <Button onClick={() => createMut.mutate()} disabled={!newId.trim() || createMut.isPending} className="h-7 bg-primary text-primary-foreground hover:bg-primary/90 text-xs flex-1">
                {createMut.isPending ? "Creating…" : "Create"}
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)} className="h-7 border border-border text-xs">Cancel</Button>
            </div>
            <p className="font-mono text-[9px] text-muted-foreground/70">Slug: letters, digits, dash, underscore. Set buckets/queues after, in Infrastructure.</p>
          </div>
        )}
        <div className="flex-1 overflow-auto">
          {isLoading && <div className="p-4 font-mono text-xs text-muted-foreground">Loading…</div>}
          {teams.map((t) => (
            <button
              key={t.team_id}
              onClick={() => setSelectedId(t.team_id)}
              className={cn(
                "w-full text-left px-4 py-3 border-l-2 border-b border-border transition-colors",
                (draft?.team_id ?? selected?.team_id) === t.team_id ? "border-l-primary bg-surface-2" : "border-l-transparent hover:bg-surface-2"
              )}
            >
              <div className="text-sm font-medium text-foreground flex items-center gap-2">
                {t.name}
                {t.active === false && <span className="font-mono text-[9px] uppercase px-1 border border-border text-muted-foreground rounded-sm">off</span>}
                {t.infra && Object.values(t.infra).some(Boolean) && <span className="font-mono text-[9px] uppercase px-1 border border-primary/40 text-primary rounded-sm">infra</span>}
              </div>
              <div className="font-mono text-[10px] text-muted-foreground mt-1">
                {t.team_id} · {canEdit(t.team_id) ? "editable" : "read-only"}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <div className="flex-1 overflow-auto">
        {!draft ? (
          <div className="p-12 text-center font-mono text-xs text-muted-foreground">Select a team, or create one.</div>
        ) : (
          <div className="p-6 space-y-6 max-w-3xl">
            {!editable && (
              <div className="border border-border bg-surface px-3 py-2 rounded-sm font-mono text-xs text-muted-foreground">
                Read-only — you can only edit your own team's rubric.
              </div>
            )}
            {error && <div className="border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 rounded-sm font-mono text-xs">{error}</div>}

            <div>
              <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Rubric Name</label>
              <Input value={draft.name} disabled={!editable} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="mt-1 bg-surface border-border" />
            </div>

            <div>
              <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Description</label>
              <Input value={draft.description} disabled={!editable} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="mt-1 bg-surface border-border" />
            </div>

            <div className="flex gap-4">
              <div className="flex-1">
                <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Score scale (max)</label>
                <Input type="number" value={draft.scale_max ?? 100} disabled={!editable} onChange={(e) => setDraft({ ...draft, scale_max: Number(e.target.value) })} className="mt-1 bg-surface border-border font-mono w-28" />
              </div>
              <div className="flex-1">
                <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Flag threshold (overall &lt;)</label>
                <Input type="number" value={draft.flag_threshold} disabled={!editable} onChange={(e) => setDraft({ ...draft, flag_threshold: Number(e.target.value) })} className="mt-1 bg-surface border-border font-mono w-28" />
              </div>
              <div className="flex-1">
                <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Critical criterion (&lt;)</label>
                <Input type="number" value={draft.critical_criterion_threshold} disabled={!editable} onChange={(e) => setDraft({ ...draft, critical_criterion_threshold: Number(e.target.value) })} className="mt-1 bg-surface border-border font-mono w-28" />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Scoring Criteria</label>
                <span className="font-mono text-[10px] text-muted-foreground">weights are relative · normalized automatically</span>
              </div>
              <div className="space-y-2">
                {draft.criteria.map((c, i) => (
                  <div key={i} className="border border-border bg-surface rounded-md p-3">
                    <div className="flex gap-2 items-start">
                      <Input value={c.name} disabled={!editable} onChange={(e) => updateCriterion(i, { name: e.target.value })} placeholder="Criterion name" className="bg-background border-border flex-1" />
                      <div className="flex flex-col items-center">
                        <Input type="number" value={c.weight ?? ""} disabled={!editable} onChange={(e) => updateCriterion(i, { weight: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="wt" className="bg-background border-border w-16 font-mono" />
                        <span className="font-mono text-[9px] text-muted-foreground mt-0.5">= {sharePct(c.weight)}%</span>
                      </div>
                      <button disabled={!editable} onClick={() => removeCriterion(i)} aria-label="Remove criterion" className="p-2 rounded-sm hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-30">
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <Textarea value={c.description} disabled={!editable} onChange={(e) => updateCriterion(i, { description: e.target.value })} placeholder="Instruction for the LLM…" className="mt-2 bg-background border-border text-xs" rows={2} />
                    <Textarea value={c.guidance ?? ""} disabled={!editable} onChange={(e) => updateCriterion(i, { guidance: e.target.value || undefined })} placeholder="Optional extra guidance / examples for the auditor…" className="mt-2 bg-background border-border text-xs" rows={2} />
                    <div className="mt-2 flex items-center gap-2">
                      <label className="font-mono text-[10px] text-muted-foreground">Critical override (&lt;)</label>
                      <Input type="number" value={c.critical_threshold ?? ""} disabled={!editable} onChange={(e) => updateCriterion(i, { critical_threshold: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="—" className="bg-background border-border w-20 font-mono" />
                      <span className="font-mono text-[10px] text-muted-foreground/70">blank = use rubric default ({draft.critical_criterion_threshold})</span>
                    </div>
                  </div>
                ))}
              </div>
              {editable && (
                <Button onClick={addCriterion} variant="ghost" className="mt-2 border border-border font-mono text-xs">
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Criterion
                </Button>
              )}
            </div>

            <div>
              <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Base instruction for the LLM auditor</label>
              <Textarea value={draft.system_prompt} disabled={!editable} onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })} className="mt-1 font-mono text-xs bg-[#0D0D0D] border-border focus-visible:ring-primary min-h-[160px]" />
            </div>

            {/* Per-team infrastructure — super_admin only. Blank = use the global env default. */}
            {isSuper && (
              <div className="border border-border rounded-md p-4 bg-surface">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Infrastructure (per-team)</div>
                <p className="font-mono text-[10px] text-muted-foreground/70 mb-3">Leave a field blank to use the global default. Set these to onboard a team with its own bucket/queues.</p>
                <div className="grid grid-cols-2 gap-3">
                  {INFRA_FIELDS.map((f) => {
                    const val = (draft.infra ?? {})[f.key];
                    return (
                      <div key={f.key} className={f.numeric ? "" : "col-span-2"}>
                        <label className="font-mono text-[10px] text-muted-foreground">{f.label}</label>
                        <Input
                          type={f.numeric ? "number" : "text"}
                          value={val ?? ""}
                          onChange={(e) =>
                            updateInfra(f.key, e.target.value === "" ? undefined : f.numeric ? Number(e.target.value) : e.target.value)
                          }
                          placeholder="global default"
                          className="mt-1 bg-background border-border font-mono text-xs"
                        />
                      </div>
                    );
                  })}
                </div>
                <label className="mt-3 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
                  <input type="checkbox" checked={draft.active !== false} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                  Team active (workers poll its queue)
                </label>
              </div>
            )}

            {editable && (
              <div className="flex gap-2 sticky bottom-0 bg-background py-3 border-t border-border">
                <Button onClick={() => saveMut.mutate(draft)} disabled={saveMut.isPending} className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
                  {saveMut.isPending ? "Saving…" : "Save Changes"}
                </Button>
                <Button variant="ghost" onClick={() => selected && setDraft(selected)} className="border border-border">Discard</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
