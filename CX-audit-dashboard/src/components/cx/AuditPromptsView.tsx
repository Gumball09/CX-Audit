import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { type User, type Criterion, type Rubric, type RubricSuggestion, type Team, type TeamInfra, type TeamRubric } from "@/lib/cx-data";
import {
  fetchTeams, updateTeam, createTeam, fetchRubrics, createRubric, updateRubric, deleteRubric,
  fetchSuggestions, generateSuggestion, updateSuggestionStatus, deleteSuggestion,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronDown, ChevronRight, Lightbulb, Minus, Plus, Sparkles, Trash2 } from "lucide-react";
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

  // A critical override is "flag if the criterion scores below this"; since a
  // criterion can earn at most its weight, a threshold at or above the weight
  // would flag even a perfect pass. So it must stay strictly below the weight.
  const criterionError = (c: Criterion): string | null =>
    c.critical_threshold !== undefined && c.weight !== undefined && c.weight > 0 && c.critical_threshold >= c.weight
      ? `must be < weight (${c.weight})`
      : null;
  const hasCriterionErrors = !!draft?.criteria.some((c) => criterionError(c));

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
                {draft.criteria.map((c, i) => {
                  const critErr = criterionError(c);
                  return (
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
                      <Input type="number" value={c.critical_threshold ?? ""} disabled={!editable} onChange={(e) => updateCriterion(i, { critical_threshold: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="—" className={cn("bg-background border-border w-20 font-mono", critErr && "border-destructive focus-visible:ring-destructive")} />
                      <span className={cn("font-mono text-[10px]", critErr ? "text-destructive" : "text-muted-foreground/70")}>
                        {critErr ? `${critErr} · ` : "must be < weight · "}blank = use rubric default ({draft.critical_criterion_threshold})
                      </span>
                    </div>
                  </div>
                  );
                })}
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

            {/* Additional rubrics — every call is scored against the primary (above) + these. */}
            <RubricsManager teamId={draft.team_id} canEdit={editable} />

            {/* Feedback-driven rubric improvement suggestions. */}
            <SuggestionsPanel
              teamId={draft.team_id}
              primaryRubricName={draft.name}
              canEdit={editable}
              onApplyPrimaryPrompt={(prompt) => setDraft({ ...draft, system_prompt: prompt })}
            />

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
                <Button onClick={() => saveMut.mutate(draft)} disabled={saveMut.isPending || hasCriterionErrors} className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
                  {saveMut.isPending ? "Saving…" : "Save Changes"}
                </Button>
                <Button variant="ghost" onClick={() => selected && setDraft(selected)} className="border border-border">Discard</Button>
                {hasCriterionErrors && <span className="self-center font-mono text-[10px] text-destructive">Fix critical overrides (must be &lt; weight) to save.</span>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Feedback loop: generates LLM suggestions for improving a rubric by analyzing
 * how reviewers corrected the AI's audits, and lets an admin apply (the new
 * system prompt) or dismiss each suggestion. Covers the primary rubric and any
 * additional rubrics on the team.
 */
function SuggestionsPanel({
  teamId,
  primaryRubricName,
  canEdit,
  onApplyPrimaryPrompt,
}: {
  teamId: Team;
  primaryRubricName: string;
  canEdit: boolean;
  onApplyPrimaryPrompt: (prompt: string) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [rubricId, setRubricId] = useState("primary");

  const { data: suggestions = [] } = useQuery<RubricSuggestion[]>({
    queryKey: ["suggestions", teamId],
    queryFn: () => fetchSuggestions(teamId),
    enabled: canEdit && open,
  });
  const { data: additional = [] } = useQuery<Rubric[]>({
    queryKey: ["rubrics", teamId],
    queryFn: () => fetchRubrics(teamId),
    enabled: canEdit && open,
  });

  const rubricOptions = [{ id: "primary", name: primaryRubricName || "Primary rubric" }, ...additional.map((r) => ({ id: r.rubric_id, name: r.name }))];

  const generate = useMutation({
    mutationFn: () => generateSuggestion(teamId, rubricId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suggestions", teamId] }),
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "applied" | "dismissed" | "open" }) => updateSuggestionStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suggestions", teamId] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteSuggestion(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suggestions", teamId] }),
  });
  const applyToRubric = useMutation({
    mutationFn: ({ rid, prompt }: { rid: string; prompt: string }) => updateRubric(rid, { system_prompt: prompt }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rubrics", teamId] }),
  });

  const apply = (s: RubricSuggestion) => {
    if (!s.suggested_system_prompt) return;
    if (s.rubric_id === "primary") onApplyPrimaryPrompt(s.suggested_system_prompt);
    else applyToRubric.mutate({ rid: s.rubric_id, prompt: s.suggested_system_prompt });
    setStatus.mutate({ id: s.suggestion_id, status: "applied" });
  };

  if (!canEdit) return null;

  return (
    <div className="border border-border rounded-md p-4 bg-surface">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 w-full text-left">
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Lightbulb className="h-4 w-4 text-[color:var(--oorp)]" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Improvement Suggestions</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <p className="font-mono text-[10px] text-muted-foreground/70">
            Generates rubric edits from reviewer feedback on this team's audits (AI score vs. human correction).
          </p>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="font-mono text-[10px] text-muted-foreground">Rubric to analyze</label>
              <Select value={rubricId} onValueChange={setRubricId}>
                <SelectTrigger className="mt-1 h-8 bg-background border-border text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {rubricOptions.map((r) => <SelectItem key={r.id} value={r.id} className="text-xs">{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => generate.mutate()} disabled={generate.isPending} className="h-8 text-xs bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              <Sparkles className={cn("h-3.5 w-3.5 mr-1", generate.isPending && "animate-pulse")} />
              {generate.isPending ? "Analyzing…" : "Generate"}
            </Button>
          </div>
          {generate.isError && <p className="text-xs text-destructive">{(generate.error as Error).message}</p>}

          {suggestions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No suggestions yet. Collect reviewer feedback on calls, then generate.</p>
          ) : (
            <ul className="space-y-3">
              {suggestions.map((s) => (
                <li key={s.suggestion_id} className={cn("border rounded-md p-3 bg-background space-y-2", s.status === "applied" ? "border-emerald-500/30" : s.status === "dismissed" ? "border-border opacity-60" : "border-[color:var(--oorp)]/30")}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{s.rubric_name}</span>
                    <span className="font-mono text-[9px] uppercase px-1.5 py-0.5 border border-border text-muted-foreground rounded-sm">{s.status}</span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">{s.based_on_feedback_count} feedback · {new Date(s.created_at).toLocaleDateString()}</span>
                    <button onClick={() => remove.mutate(s.suggestion_id)} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3 w-3" /></button>
                  </div>
                  <p className="text-xs text-foreground/85 leading-relaxed">{s.summary}</p>
                  {s.criteria_changes.length > 0 && (
                    <ul className="space-y-1.5">
                      {s.criteria_changes.map((c, i) => (
                        <li key={i} className="text-xs border-l-2 border-border pl-2">
                          <span className="font-medium">{c.criterion}:</span> <span className="text-foreground/80">{c.change}</span>
                          <span className="block text-muted-foreground text-[11px]">{c.rationale}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {s.suggested_system_prompt && (
                    <details className="text-xs">
                      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Suggested system prompt</summary>
                      <pre className="font-mono text-[11px] text-foreground/85 bg-[#0D0D0D] border border-border rounded-md p-2 mt-1 whitespace-pre-wrap leading-relaxed">{s.suggested_system_prompt}</pre>
                    </details>
                  )}
                  {s.status === "open" && (
                    <div className="flex gap-2 pt-1">
                      <Button onClick={() => apply(s)} disabled={!s.suggested_system_prompt} className="h-7 text-xs bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40">Apply prompt</Button>
                      <Button variant="ghost" onClick={() => setStatus.mutate({ id: s.suggestion_id, status: "dismissed" })} className="h-7 text-xs border border-border">Dismiss</Button>
                    </div>
                  )}
                  {s.status === "applied" && s.rubric_id === "primary" && (
                    <p className="text-[11px] text-muted-foreground">Applied to the editor above — hit <span className="font-medium">Save Changes</span> to persist.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Manages a team's *additional* rubrics (beyond the primary one above). Every
 * call is scored against the primary + all active additional rubrics.
 */
function RubricsManager({ teamId, canEdit }: { teamId: Team; canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: rubrics = [] } = useQuery<Rubric[]>({
    queryKey: ["rubrics", teamId],
    queryFn: () => fetchRubrics(teamId),
    enabled: canEdit, // endpoint is admin+; users never see this view anyway
  });
  const [newName, setNewName] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["rubrics", teamId] });

  const addMut = useMutation({
    mutationFn: () =>
      createRubric({
        team_id: teamId,
        name: newName.trim(),
        criteria: [{ name: "Quality", weight: 100, description: "Overall quality for this rubric." }],
        system_prompt: "You are a CX quality auditor. Score the transcript against each criterion.",
      }),
    onSuccess: () => { setNewName(""); invalidate(); },
  });
  const saveMut = useMutation({
    mutationFn: (r: Rubric) => updateRubric(r.rubric_id, {
      name: r.name, system_prompt: r.system_prompt, criteria: r.criteria,
      flag_threshold: r.flag_threshold, critical_criterion_threshold: r.critical_criterion_threshold,
      scale_max: r.scale_max, active: r.active,
    }),
    onSuccess: invalidate,
  });
  const delMut = useMutation({ mutationFn: (id: string) => deleteRubric(id), onSuccess: invalidate });

  if (!canEdit) return null;

  return (
    <div className="border border-border rounded-md p-4 bg-surface">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Additional Rubrics</div>
      <p className="font-mono text-[10px] text-muted-foreground/70 mb-3">Each call is scored against the primary rubric above + every active rubric here. A call is flagged if any rubric flags it.</p>

      <div className="space-y-2">
        {rubrics.map((r) => (
          <RubricRow
            key={r.rubric_id}
            rubric={r}
            open={openId === r.rubric_id}
            onToggle={() => setOpenId(openId === r.rubric_id ? null : r.rubric_id)}
            onSave={(updated) => saveMut.mutate(updated)}
            onDelete={() => delMut.mutate(r.rubric_id)}
            onActive={(active) => saveMut.mutate({ ...r, active })}
          />
        ))}
        {rubrics.length === 0 && <div className="font-mono text-[11px] text-muted-foreground/60">No additional rubrics yet.</div>}
      </div>

      <div className="flex gap-2 mt-3">
        <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New rubric name (e.g. False Promises)" className="bg-background border-border text-xs h-8" />
        <Button onClick={() => addMut.mutate()} disabled={!newName.trim() || addMut.isPending} className="h-8 bg-primary text-primary-foreground hover:bg-primary/90 text-xs">
          <Plus className="h-3.5 w-3.5 mr-1" /> Add
        </Button>
      </div>
    </div>
  );
}

function RubricRow({
  rubric, open, onToggle, onSave, onDelete, onActive,
}: {
  rubric: Rubric; open: boolean; onToggle: () => void;
  onSave: (r: Rubric) => void; onDelete: () => void; onActive: (active: boolean) => void;
}) {
  const [draft, setDraft] = useState<Rubric>(rubric);
  useEffect(() => setDraft(rubric), [rubric]);
  const setC = (i: number, patch: Partial<Criterion>) =>
    setDraft({ ...draft, criteria: draft.criteria.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) });

  return (
    <div className="border border-border rounded-md bg-background">
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={onToggle} className="text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <span className="text-sm flex-1">{rubric.name}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{rubric.criteria.length} criteria</span>
        <Switch checked={rubric.active} onCheckedChange={onActive} />
        <button onClick={onDelete} aria-label="Delete rubric" className="p-1.5 rounded-sm hover:bg-destructive/10 text-muted-foreground hover:text-destructive">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-border pt-2">
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="bg-surface border-border text-xs" placeholder="Rubric name" />
          <div className="flex gap-2">
            <Input type="number" value={draft.flag_threshold} onChange={(e) => setDraft({ ...draft, flag_threshold: Number(e.target.value) })} className="bg-surface border-border font-mono text-xs w-24" placeholder="flag <" />
            <Input type="number" value={draft.critical_criterion_threshold} onChange={(e) => setDraft({ ...draft, critical_criterion_threshold: Number(e.target.value) })} className="bg-surface border-border font-mono text-xs w-24" placeholder="critical <" />
          </div>
          {draft.criteria.map((c, i) => (
            <div key={i} className="space-y-1 border border-border/50 rounded-sm p-2">
              <div className="flex gap-2 items-center">
                <Input value={c.name} onChange={(e) => setC(i, { name: e.target.value })} placeholder="Criterion" className="bg-surface border-border text-xs flex-1" />
                <Input type="number" value={c.weight ?? ""} onChange={(e) => setC(i, { weight: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="wt" className="bg-surface border-border font-mono text-xs w-14" />
                <button onClick={() => setDraft({ ...draft, criteria: draft.criteria.filter((_, idx) => idx !== i) })} className="p-1.5 text-muted-foreground hover:text-destructive"><Minus className="h-3.5 w-3.5" /></button>
              </div>
              <Textarea value={c.description} onChange={(e) => setC(i, { description: e.target.value })} placeholder="Instruction for the auditor…" rows={1} className="bg-surface border-border text-xs" />
            </div>
          ))}
          <div className="flex gap-2">
            <Button onClick={() => setDraft({ ...draft, criteria: [...draft.criteria, { name: "", weight: 0, description: "" }] })} variant="ghost" className="h-7 border border-border text-xs"><Plus className="h-3 w-3 mr-1" />Criterion</Button>
          </div>
          <Textarea value={draft.system_prompt} onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })} className="font-mono text-xs bg-[#0D0D0D] border-border min-h-[80px]" placeholder="Base instruction for this rubric…" />
          <Button onClick={() => onSave(draft)} className="h-7 bg-primary text-primary-foreground hover:bg-primary/90 text-xs">Save rubric</Button>
        </div>
      )}
    </div>
  );
}
