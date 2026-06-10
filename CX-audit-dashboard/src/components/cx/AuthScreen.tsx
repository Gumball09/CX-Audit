import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { User } from "@/lib/cx-data";
import { login } from "@/lib/api";
import { AudioWaveform } from "lucide-react";

export function AuthScreen({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { user } = await login(email.trim());
      onLogin(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm border border-border bg-surface p-8 rounded-md">
        <div className="flex items-center gap-2 mb-8">
          <div className="h-8 w-8 border border-primary/40 flex items-center justify-center rounded-sm">
            <AudioWaveform className="h-4 w-4 text-primary" />
          </div>
          <span className="font-mono text-xs tracking-widest text-muted-foreground">[CX]</span>
        </div>
        <h1 className="text-[28px] font-semibold text-foreground leading-tight">CX Audit Console</h1>
        <p className="font-mono text-xs text-muted-foreground mt-1">Internal access only</p>

        <form onSubmit={submit} className="mt-8 space-y-4">
          <div>
            <label className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Email address</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(""); }}
              placeholder="you@scaler.com"
              className="mt-1 font-mono bg-background border-border focus-visible:ring-primary"
              autoFocus
            />
            {error && <p className="font-mono text-xs text-destructive mt-2">{error}</p>}
          </div>
          <Button
            type="submit"
            disabled={loading}
            className="w-full bg-surface-2 hover:bg-primary hover:text-primary-foreground border border-border transition-colors disabled:opacity-50"
          >
            {loading ? "Signing in…" : "Request Access"}
          </Button>
        </form>

        <p className="font-mono text-[10px] text-muted-foreground/60 mt-8 leading-relaxed">
          Seeded accounts: shubh.mehrotra@scaler.com (super_admin) · priya@scaler.com (user)
        </p>
      </div>
    </div>
  );
}
