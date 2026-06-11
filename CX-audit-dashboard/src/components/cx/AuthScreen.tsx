import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { User } from "@/lib/cx-data";
import { login, setPassword as setPasswordApi } from "@/lib/api";
import { AudioWaveform } from "lucide-react";

const MIN_PASSWORD = 8;

export function AuthScreen({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // "login" = email + password; "setup" = first login, choose a new password.
  const [mode, setMode] = useState<"login" | "setup">("login");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const resetTo = (next: "login" | "setup") => {
    setMode(next);
    setPassword("");
    setConfirm("");
    setError("");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (mode === "login") {
        const result = await login(email.trim(), password);
        if ("needsPasswordSetup" in result) {
          resetTo("setup"); // first login — ask them to choose a password
          return;
        }
        onLogin(result.user);
      } else {
        if (password.length < MIN_PASSWORD) {
          setError(`Password must be at least ${MIN_PASSWORD} characters.`);
          return;
        }
        if (password !== confirm) {
          setError("Passwords do not match.");
          return;
        }
        const { user } = await setPasswordApi(email.trim(), password);
        onLogin(user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setLoading(false);
    }
  };

  const inputClass = "mt-1 font-mono bg-background border-border focus-visible:ring-primary";

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
        <p className="font-mono text-xs text-muted-foreground mt-1">
          {mode === "setup" ? "First login — set your password" : "Internal access only"}
        </p>

        <form onSubmit={submit} className="mt-8 space-y-4">
          <div>
            <label className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Email address</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(""); }}
              placeholder="you@scaler.com"
              className={inputClass}
              autoFocus
              readOnly={mode === "setup"}
            />
          </div>

          {mode === "login" ? (
            <div>
              <label className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Password</label>
              <Input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(""); }}
                placeholder="••••••••"
                className={inputClass}
              />
            </div>
          ) : (
            <>
              <div>
                <label className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">New password</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(""); }}
                  placeholder={`at least ${MIN_PASSWORD} characters`}
                  className={inputClass}
                  autoFocus
                />
              </div>
              <div>
                <label className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Confirm password</label>
                <Input
                  type="password"
                  value={confirm}
                  onChange={(e) => { setConfirm(e.target.value); setError(""); }}
                  placeholder="••••••••"
                  className={inputClass}
                />
              </div>
            </>
          )}

          {error && <p className="font-mono text-xs text-destructive">{error}</p>}

          <Button
            type="submit"
            disabled={loading}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {loading
              ? mode === "setup" ? "Setting password…" : "Signing in…"
              : mode === "setup" ? "Set password & sign in" : "Sign in"}
          </Button>

          {mode === "setup" && (
            <button
              type="button"
              onClick={() => resetTo("login")}
              className="w-full font-mono text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              ← back to sign in
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
