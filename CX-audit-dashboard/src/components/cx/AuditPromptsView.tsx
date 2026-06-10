import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { type User, type Criterion, type Team, type TeamRubric } from "@/lib/cx-data";
import { fetchTeams, updateTeam } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export function AuditPromptsView({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const { data: teams = [], isLoading } = useQuery<TeamRubric[]>({ queryKey: ["teams"], queryFn: fetchTeams });

  const [selectedId, setSelectedId] = useState<Team | null>(null);
  const [draft, setDraft] = useState<TeamRubric | null>(null);
  const [error, setError] = useState("");

  const selected = teams.find((t) => t.team_id === selectedId) ?? teams[0] ?? null;

  useEffect(() => {
    if (selected && selected.team_id !== draft?.team_id) setDraft(selected);
  }, [selected, draft?.team_id]);

  const canEdit = (teamId: Team) => user.role === "super_admin" || (user.role === "admin" && user.team === teamId);
  const editable = draft ? canEdit(draft.team_id) : false;

  const weightSum = draft?.criteria.reduce((s, c) => s + (Number(c.weight) || 0), 0) ?? 0;

  const saveMut = useMutation({
    mutationFn: (rubric: TeamRubric) =>
      updateTeam(rubric.team_id, {
        name: rubric.name,
        description: rubric.description,
        criteria: rubric.criteria,
        system_prompt: rubric.system_prompt,
        flag_threshold: rubric.flag_threshold,
        critical_criterion_threshold: rubric.critical_criterion_threshold,
      }),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      setDraft(updated);
      setError("");
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Save failed."),
  });

  const updateCriterion = (i: number, patch: Partial<Criterion>) =>
    draft && setDraft({ ...draft, criteria: draft.criteria.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) });
  const addCriterion = () => draft && setDraft({ ...draft, criteria: [...draft.criteria, { name: "", weight: 0, description: "" }] });
  const removeCriterion = (i: number) => draft && setDraft({ ...draft, criteria: draft.criteria.filter((_, idx) => idx !== i) });

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      <aside className="w-[300px] shrink-0 border-r border-border bg-surface flex flex-col">
        <div className="p-4 border-b border-border font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Teams</div>
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
              <div className="text-sm font-medium text-foreground">{t.name}</div>
              <div className="font-mono text-[10px] text-muted-foreground mt-1">
                {t.team_id} · {canEdit(t.team_id) ? "editable" : "read-only"}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <div className="flex-1 overflow-auto">
        {!draft ? (
          <div className="p-12 text-center font-mono text-xs text-muted-foreground">Select a team to view its rubric.</div>
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
                <span className={cn("font-mono text-xs", weightSum === 100 ? "text-emerald-400" : "text-[color:var(--oorp)]")}>Sum: {weightSum}%</span>
              </div>
              <div className="space-y-2">
                {draft.criteria.map((c, i) => (
                  <div key={i} className="border border-border bg-surface rounded-md p-3">
                    <div className="flex gap-2 items-start">
                      <Input value={c.name} disabled={!editable} onChange={(e) => updateCriterion(i, { name: e.target.value })} placeholder="Criterion name" className="bg-background border-border flex-1" />
                      <Input type="number" value={c.weight} disabled={!editable} onChange={(e) => updateCriterion(i, { weight: Number(e.target.value) })} className="bg-background border-border w-20 font-mono" />
                      <span className="font-mono text-xs text-muted-foreground self-center">%</span>
                      <button disabled={!editable} onClick={() => removeCriterion(i)} aria-label="Remove criterion" className="p-2 rounded-sm hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-30">
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <Textarea value={c.description} disabled={!editable} onChange={(e) => updateCriterion(i, { description: e.target.value })} placeholder="Instruction for the LLM…" className="mt-2 bg-background border-border text-xs" rows={2} />
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

            {editable && weightSum !== 100 && (
              <div className="border border-[color:var(--oorp)]/40 bg-[color:var(--oorp)]/10 text-[color:var(--oorp)] px-3 py-2 rounded-sm font-mono text-xs">
                Weights must total 100% before saving.
              </div>
            )}

            {editable && (
              <div className="flex gap-2 sticky bottom-0 bg-background py-3 border-t border-border">
                <Button onClick={() => saveMut.mutate(draft)} disabled={weightSum !== 100 || saveMut.isPending} className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
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
