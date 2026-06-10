import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { type PlatformSettings, type User, AUDIT_MODELS, TRANSCRIPTION_MODELS } from "@/lib/cx-data";
import { fetchSettings, updateSettings } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Super-admin platform settings — currently the OpenAI models used for
 * transcription and auditing. Changes take effect within ~60s (worker cache).
 */
export function SettingsView({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const isSuper = user.role === "super_admin";
  const { data, isLoading } = useQuery<PlatformSettings>({ queryKey: ["settings"], queryFn: fetchSettings });

  const [transcription, setTranscription] = useState("");
  const [audit, setAudit] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) {
      setTranscription(data.transcription_model);
      setAudit(data.audit_model);
    }
  }, [data]);

  const saveMut = useMutation({
    mutationFn: () => updateSettings({ transcription_model: transcription.trim(), audit_model: audit.trim() }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["settings"], updated);
      setError("");
      setSaved(true);
    },
    onError: (e) => { setSaved(false); setError(e instanceof Error ? e.message : "Save failed."); },
  });

  const dirty = !!data && (transcription.trim() !== data.transcription_model || audit.trim() !== data.audit_model);

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <p className="font-mono text-xs text-muted-foreground">
        These OpenAI models are used by the pipeline. Changes apply within ~60 seconds as the workers refresh their cache.
      </p>

      {isLoading && <div className="font-mono text-xs text-muted-foreground">Loading…</div>}
      {error && <div className="border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 rounded-sm font-mono text-xs">{error}</div>}

      <datalist id="transcription-models">{TRANSCRIPTION_MODELS.map((m) => <option key={m} value={m} />)}</datalist>
      <datalist id="audit-models">{AUDIT_MODELS.map((m) => <option key={m} value={m} />)}</datalist>

      <div>
        <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Transcription model (Whisper)</label>
        <Input list="transcription-models" value={transcription} disabled={!isSuper} onChange={(e) => { setTranscription(e.target.value); setSaved(false); }} className="mt-1 bg-surface border-border font-mono" />
        <p className="font-mono text-[10px] text-muted-foreground/70 mt-1">Suggested: {TRANSCRIPTION_MODELS.join(", ")}</p>
      </div>

      <div>
        <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Audit model (GPT)</label>
        <Input list="audit-models" value={audit} disabled={!isSuper} onChange={(e) => { setAudit(e.target.value); setSaved(false); }} className="mt-1 bg-surface border-border font-mono" />
        <p className="font-mono text-[10px] text-muted-foreground/70 mt-1">Suggested: {AUDIT_MODELS.join(", ")}</p>
      </div>

      {data?.updated_at && (
        <p className="font-mono text-[10px] text-muted-foreground/60">Last updated {new Date(data.updated_at).toLocaleString()}{data.updated_by ? ` by ${data.updated_by}` : ""}</p>
      )}

      {isSuper ? (
        <div className="flex items-center gap-3">
          <Button onClick={() => saveMut.mutate()} disabled={!dirty || !transcription.trim() || !audit.trim() || saveMut.isPending} className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
            {saveMut.isPending ? "Saving…" : "Save Models"}
          </Button>
          {saved && !dirty && <span className="font-mono text-xs text-emerald-400">Saved ✓</span>}
        </div>
      ) : (
        <div className="border border-border bg-surface px-3 py-2 rounded-sm font-mono text-xs text-muted-foreground">Read-only — only super admins can change models.</div>
      )}
    </div>
  );
}
