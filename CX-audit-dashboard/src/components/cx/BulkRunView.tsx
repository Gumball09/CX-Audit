import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { type BulkRunResult, type User } from "@/lib/cx-data";
import { bulkReprocess } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle, CheckCircle2, Eye, Info, Loader2, PlayCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type Mode = "prefix" | "keys";

/**
 * Super-admin bulk runner: push many recordings through the pipeline at once,
 * by S3 prefix (e.g. a date folder) or an explicit key list. Enforces a
 * preview-then-confirm flow because a real run re-incurs OpenAI cost.
 */
export function BulkRunView({ user }: { user: User }) {
  const [mode, setMode] = useState<Mode>("prefix");
  const [prefix, setPrefix] = useState("");
  const [keysText, setKeysText] = useState("");
  const [ack, setAck] = useState(false);
  const [preview, setPreview] = useState<BulkRunResult | null>(null);
  const [previewSig, setPreviewSig] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<BulkRunResult | null>(null);

  const enabled = user.role === "super_admin";

  const keysList = useMemo(
    () => keysText.split(/\r?\n/).map((k) => k.trim()).filter(Boolean),
    [keysText]
  );

  // A signature of the current input; if it changes after a preview, the
  // preview is stale and the Run button is re-locked until you preview again.
  const inputSig = mode === "prefix" ? `prefix:${prefix.trim()}` : `keys:${keysList.join("|")}`;
  const inputEmpty = mode === "prefix" ? !prefix.trim() : keysList.length === 0;
  const stale = preview !== null && previewSig !== inputSig;

  const buildInput = (dryRun: boolean) =>
    mode === "prefix"
      ? { prefix: prefix.trim(), dryRun }
      : { recording_keys: keysList, dryRun };

  const onInputChange = () => {
    // Any edit invalidates a prior preview/result and the acknowledgement.
    if (preview) setPreview(null);
    if (runResult) setRunResult(null);
    if (ack) setAck(false);
  };

  const previewMut = useMutation({
    mutationFn: () => bulkReprocess(buildInput(true)),
    onSuccess: (res) => {
      setPreview(res);
      setPreviewSig(inputSig);
      setRunResult(null);
    },
  });

  const runMut = useMutation({
    mutationFn: () => bulkReprocess(buildInput(false)),
    onSuccess: (res) => {
      setRunResult(res);
      setPreview(null);
      setAck(false);
    },
  });

  const canRun = !!preview && !stale && !inputEmpty && preview.valid > 0 && ack && !runMut.isPending;

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      {/* Instructions */}
      <div className="border border-border bg-surface rounded-md p-4 space-y-2">
        <div className="flex items-center gap-2 text-foreground">
          <Info className="h-4 w-4 text-primary" />
          <span className="font-mono text-[11px] uppercase tracking-wider">How bulk run works</span>
        </div>
        <ul className="text-xs text-muted-foreground leading-relaxed list-disc pl-5 space-y-1">
          <li>Queues recordings through the full pipeline (transcribe → audit). Each is routed to its team automatically from the agent mapping.</li>
          <li><span className="text-foreground">By prefix:</span> an S3 folder in the recording bucket, e.g. <code className="text-foreground">Scaler/14_06_2026/</code> (keep the trailing slash). <span className="text-foreground">Paste keys:</span> one full S3 key per line.</li>
          <li>Always <span className="text-foreground">Preview</span> first — it shows how many calls match and their team split <span className="text-foreground">without</span> running anything.</li>
          <li>Re-running is safe — it updates the same audit rows, never duplicates — but it <span className="text-[color:var(--escalations)]">re-incurs OpenAI transcription + audit cost</span> each time.</li>
          <li>Processing is asynchronous; results appear in <span className="text-foreground">Call Audits</span> as each call finishes. Batches are capped at 2,000 per run.</li>
        </ul>
      </div>

      {/* Mode toggle */}
      <div className="flex border border-border rounded-sm overflow-hidden w-fit">
        {(["prefix", "keys"] as const).map((m) => (
          <button
            key={m}
            onClick={() => { setMode(m); onInputChange(); }}
            className={cn(
              "px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
              mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-surface-2"
            )}
          >
            {m === "prefix" ? "By S3 prefix" : "Paste keys"}
          </button>
        ))}
      </div>

      {/* Input */}
      {mode === "prefix" ? (
        <div className="space-y-1.5">
          <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">S3 prefix</label>
          <Input
            value={prefix}
            onChange={(e) => { setPrefix(e.target.value); onInputChange(); }}
            placeholder="Scaler/14_06_2026/"
            className="bg-surface border-border font-mono text-xs"
          />
        </div>
      ) : (
        <div className="space-y-1.5">
          <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Recording keys — one per line {keysList.length > 0 && `· ${keysList.length}`}
          </label>
          <Textarea
            value={keysText}
            onChange={(e) => { setKeysText(e.target.value); onInputChange(); }}
            placeholder={"Scaler/14_06_2026/460016_xxx.mp3\nScaler/14_06_2026/495370_yyy.mp3"}
            rows={6}
            className="bg-surface border-border font-mono text-xs"
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          onClick={() => previewMut.mutate()}
          disabled={!enabled || inputEmpty || previewMut.isPending}
          className="font-mono text-xs h-9 border border-border hover:bg-surface-2"
        >
          {previewMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Eye className="h-3.5 w-3.5 mr-1.5" />}
          Preview
        </Button>
        <Button
          onClick={() => runMut.mutate()}
          disabled={!canRun}
          className="font-mono text-xs h-9 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {runMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5 mr-1.5" />}
          {preview && !stale ? `Queue ${preview.valid} call${preview.valid === 1 ? "" : "s"}` : "Queue calls"}
        </Button>
        {preview && !stale && preview.valid > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <Checkbox checked={ack} onCheckedChange={(v) => setAck(!!v)} />
            I understand this re-incurs OpenAI cost
          </label>
        )}
        {stale && <span className="font-mono text-[10px] text-[color:var(--escalations)]">Input changed — preview again before running.</span>}
      </div>

      {(previewMut.isError || runMut.isError) && (
        <div className="border border-[color:var(--escalations)]/40 bg-surface rounded-md p-3 text-xs text-[color:var(--escalations)]">
          {((previewMut.error || runMut.error) as Error)?.message ?? "Request failed."}
        </div>
      )}

      {/* Preview result */}
      {preview && !stale && !runResult && (
        <ResultCard
          title="Preview — nothing has run yet"
          icon={<Eye className="h-4 w-4 text-primary" />}
          result={preview}
        />
      )}

      {/* Run result */}
      {runResult && (
        <ResultCard
          title={`Queued ${runResult.queued} call${runResult.queued === 1 ? "" : "s"} — processing now`}
          icon={<CheckCircle2 className="h-4 w-4 text-emerald-400" />}
          result={runResult}
          footer="Results appear in Call Audits as each call finishes (this can take a while)."
        />
      )}
    </div>
  );
}

function ResultCard({
  title,
  icon,
  result,
  footer,
}: {
  title: string;
  icon: React.ReactNode;
  result: BulkRunResult;
  footer?: string;
}) {
  const teams = Object.entries(result.by_team).sort((a, b) => b[1] - a[1]);
  return (
    <div className="border border-border bg-surface rounded-md p-4 space-y-3">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-sm font-semibold">{title}</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Matched" value={result.total} />
        <Stat label="Valid" value={result.valid} />
        <Stat label={result.dryRun ? "Would queue" : "Queued"} value={result.dryRun ? result.valid : result.queued} />
        <Stat label="Invalid" value={result.invalid} tone={result.invalid > 0 ? "warn" : "muted"} />
      </div>

      {result.truncated && (
        <div className="flex items-center gap-2 text-xs text-[color:var(--escalations)]">
          <AlertTriangle className="h-3.5 w-3.5" /> Capped at 2,000 — narrow the prefix or split the list to cover the rest.
        </div>
      )}

      {teams.length > 0 && (
        <div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">By team</div>
          <div className="flex flex-wrap gap-2">
            {teams.map(([t, n]) => (
              <span key={t} className="font-mono text-[11px] px-2 py-0.5 border border-border rounded-sm">
                {t === "—" ? "unmapped" : t}: <span className="text-foreground">{n}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {result.sample && result.sample.length > 0 && (
        <details className="text-xs">
          <summary className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground cursor-pointer">
            Sample keys ({result.sample.length})
          </summary>
          <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-muted-foreground">
            {result.sample.map((k) => <li key={k} className="truncate">{k}</li>)}
          </ul>
        </details>
      )}

      {result.errors.length > 0 && (
        <details className="text-xs" open>
          <summary className="font-mono text-[10px] uppercase tracking-wider text-[color:var(--escalations)] cursor-pointer">
            Invalid / errored ({result.errors.length}{result.invalid > result.errors.length ? ` of ${result.invalid} shown` : ""})
          </summary>
          <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-muted-foreground">
            {result.errors.map((e) => (
              <li key={e.key} className="truncate"><span className="text-foreground">{e.key}</span> — {e.reason}</li>
            ))}
          </ul>
        </details>
      )}

      {footer && <p className="text-xs text-muted-foreground border-t border-border pt-2">{footer}</p>}
    </div>
  );
}

function Stat({ label, value, tone = "muted" }: { label: string; value: number; tone?: "muted" | "warn" }) {
  return (
    <div className="border border-border bg-background rounded-md p-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("text-xl font-bold mt-0.5 tabular-nums", tone === "warn" && "text-[color:var(--escalations)]")}>{value}</div>
    </div>
  );
}
