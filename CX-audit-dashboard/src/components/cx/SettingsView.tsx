import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type AiProvider,
  type PlatformSettings,
  type User,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
} from "@/lib/cx-data";
import { fetchSettings, updateSettings } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Super-admin platform settings: which AI provider runs the pipeline, the models
 * it uses, and the minimum call length worth auditing. Changes take effect within
 * ~60s (worker cache).
 */
export function SettingsView({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const isSuper = user.role === "super_admin";
  const { data, isLoading } = useQuery<PlatformSettings>({ queryKey: ["settings"], queryFn: fetchSettings });

  const [provider, setProvider] = useState<AiProvider>("sarvam");
  const [transcription, setTranscription] = useState("");
  const [audit, setAudit] = useState("");
  const [minMinutes, setMinMinutes] = useState(""); // shown in minutes, stored as seconds
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const currentMinSec = data?.min_audit_duration_sec ?? 600;

  useEffect(() => {
    if (data) {
      // Tolerate an API that predates ai_provider/providers. The dashboard
      // auto-deploys on merge to main while the backend needs a separate push, so
      // a new UI against an older API is a real window, not a hypothetical — and
      // an unrecognised provider here would leave every model list undefined.
      setProvider(PROVIDER_MODELS[data.ai_provider] ? data.ai_provider : "sarvam");
      setTranscription(data.transcription_model);
      setAudit(data.audit_model);
      setMinMinutes(String((data.min_audit_duration_sec ?? 600) / 60));
    }
  }, [data]);

  const minSec = Math.round(Number(minMinutes) * 60);
  const minValid = minMinutes.trim() !== "" && Number.isFinite(minSec) && minSec >= 0;
  const switching = !!data?.ai_provider && provider !== data.ai_provider;
  const suggestions = PROVIDER_MODELS[provider] ?? PROVIDER_MODELS.sarvam;

  /**
   * Switching provider also swaps the model ids, because model names are not
   * portable — leaving `gpt-4o` selected while Sarvam is active would fail every
   * audit. The server does the same reset; mirroring it here means the fields show
   * what will actually be saved rather than changing under the user after saving.
   */
  function chooseProvider(next: AiProvider) {
    const defaults = data?.providers?.find((p) => p.id === next)?.default_models;
    setProvider(next);
    if (next !== provider) {
      setTranscription(defaults?.transcription ?? PROVIDER_MODELS[next].transcription[0]);
      setAudit(defaults?.audit ?? PROVIDER_MODELS[next].audit[0]);
    }
    setSaved(false);
    setError("");
  }

  const saveMut = useMutation({
    mutationFn: () =>
      updateSettings({
        ai_provider: provider,
        transcription_model: transcription.trim(),
        audit_model: audit.trim(),
        min_audit_duration_sec: minSec,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["settings"], updated);
      setError("");
      setSaved(true);
    },
    onError: (e) => { setSaved(false); setError(e instanceof Error ? e.message : "Save failed."); },
  });

  const dirty =
    !!data &&
    (switching ||
      transcription.trim() !== data.transcription_model ||
      audit.trim() !== data.audit_model ||
      (minValid && minSec !== currentMinSec));

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <p className="font-mono text-xs text-muted-foreground">
        Pipeline settings — which AI provider transcribes and audits calls, the models it uses, and the minimum call length to audit. Changes apply within ~60 seconds as the workers refresh their cache.
      </p>

      {isLoading && <div className="font-mono text-xs text-muted-foreground">Loading…</div>}
      {error && <div className="border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 rounded-sm font-mono text-xs">{error}</div>}

      <datalist id="transcription-models">{suggestions.transcription.map((m) => <option key={m} value={m} />)}</datalist>
      <datalist id="audit-models">{suggestions.audit.map((m) => <option key={m} value={m} />)}</datalist>

      <div data-guide="settings-provider">
        <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">AI provider</label>
        <div className="mt-2 flex gap-2">
          {(data?.providers ?? []).map((p) => {
            const active = provider === p.id;
            const blocked = !p.configured;
            return (
              <button
                key={p.id}
                type="button"
                disabled={!isSuper || blocked}
                onClick={() => chooseProvider(p.id)}
                title={blocked ? "No API key configured for this provider on the server." : undefined}
                className={[
                  "px-3 py-2 rounded-sm border font-mono text-xs transition-colors",
                  active
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border bg-surface text-muted-foreground hover:text-foreground",
                  !isSuper || blocked ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
                ].join(" ")}
              >
                {PROVIDER_LABELS[p.id]}
                {p.id === data?.ai_provider && <span className="ml-2 text-[10px] opacity-70">live</span>}
                {blocked && <span className="ml-2 text-[10px]">no key</span>}
              </button>
            );
          })}
        </div>
        <p className="font-mono text-[10px] text-muted-foreground/70 mt-2">
          Sarvam handles Hindi/English code-mixed calls and separates agent from customer. OpenAI is the break-glass fallback and does not diarize.
        </p>
        {switching && (
          <div className="mt-2 border border-amber-500/40 bg-amber-500/10 text-amber-400 px-3 py-2 rounded-sm font-mono text-xs">
            Switching {PROVIDER_LABELS[data!.ai_provider]} → {PROVIDER_LABELS[provider]}. The models below have been reset to this provider's defaults. Calls already queued finish on the provider that started them.
          </div>
        )}
      </div>

      <div>
        <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Transcription model</label>
        <Input list="transcription-models" value={transcription} disabled={!isSuper} onChange={(e) => { setTranscription(e.target.value); setSaved(false); }} className="mt-1 bg-surface border-border font-mono" />
        <p className="font-mono text-[10px] text-muted-foreground/70 mt-1">Suggested for {PROVIDER_LABELS[provider]}: {suggestions.transcription.join(", ")}</p>
      </div>

      <div>
        <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Audit model</label>
        <Input list="audit-models" value={audit} disabled={!isSuper} onChange={(e) => { setAudit(e.target.value); setSaved(false); }} className="mt-1 bg-surface border-border font-mono" />
        <p className="font-mono text-[10px] text-muted-foreground/70 mt-1">Suggested for {PROVIDER_LABELS[provider]}: {suggestions.audit.join(", ")}</p>
      </div>

      <div>
        <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Minimum call length to audit (minutes)</label>
        <Input type="number" min={0} step={1} value={minMinutes} disabled={!isSuper} onChange={(e) => { setMinMinutes(e.target.value); setSaved(false); }} className="mt-1 bg-surface border-border font-mono w-40" />
        <p className="font-mono text-[10px] text-muted-foreground/70 mt-1">Calls shorter than this are skipped before transcription (0 = audit all). Applies to every team.</p>
      </div>

      {data?.updated_at && (
        <p className="font-mono text-[10px] text-muted-foreground/60">Last updated {new Date(data.updated_at).toLocaleString()}{data.updated_by ? ` by ${data.updated_by}` : ""}</p>
      )}

      {isSuper ? (
        <div className="flex items-center gap-3">
          <Button onClick={() => saveMut.mutate()} disabled={!dirty || !transcription.trim() || !audit.trim() || !minValid || saveMut.isPending} className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
            {saveMut.isPending ? "Saving…" : "Save Settings"}
          </Button>
          {saved && !dirty && <span className="font-mono text-xs text-emerald-400">Saved ✓</span>}
        </div>
      ) : (
        <div className="border border-border bg-surface px-3 py-2 rounded-sm font-mono text-xs text-muted-foreground">Read-only — only super admins can change the provider or models.</div>
      )}
    </div>
  );
}
