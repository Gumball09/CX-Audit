import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type User, canSeeAdmin, roleClass } from "@/lib/cx-data";
import { Activity, AudioWaveform, BookOpen, Crown, LineChart, LogOut, PhoneCall, PlayCircle, Regex, Settings, Users } from "lucide-react";
import { CallAuditsView } from "./CallAuditsView";
import { AgentRosterView } from "./AgentRosterView";
import { AuditPromptsView } from "./AuditPromptsView";
import { PatternsView } from "./PatternsView";
import { PerformanceView } from "./PerformanceView";
import { SignInActivityView } from "./SignInActivityView";
import { BulkRunView } from "./BulkRunView";
import { SettingsView } from "./SettingsView";
import { fetchUsers } from "@/lib/api";
import { cn } from "@/lib/utils";

type View = "calls" | "performance" | "users" | "teams" | "patterns" | "bulk" | "signins" | "settings";

const VIEW_LABELS: Record<View, string> = {
  calls: "Call Audits",
  performance: "Performance",
  users: "User Management",
  teams: "Team Rubrics",
  patterns: "Recording Patterns",
  bulk: "Bulk Run",
  signins: "Sign-in Activity",
  settings: "Settings",
};

export function DashboardShell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [view, setView] = useState<View>("calls");
  const admin = canSeeAdmin(user.role);
  const superAdmin = user.role === "super_admin";

  // A small users lookup so audits can show agent names. Admin+ only; the
  // backend scopes this to the caller's team automatically.
  const { data: users = [] } = useQuery<User[]>({
    queryKey: ["users"],
    queryFn: fetchUsers,
    enabled: admin,
  });

  const nav: { id: View; label: string; icon: React.ElementType; admin?: boolean; superAdmin?: boolean }[] = [
    { id: "calls", label: "Call Audits", icon: PhoneCall },
    { id: "performance", label: "Performance", icon: LineChart },
    { id: "users", label: "User Management", icon: Users, admin: true },
    { id: "teams", label: "Team Rubrics", icon: BookOpen, admin: true },
    { id: "patterns", label: "Recording Patterns", icon: Regex, superAdmin: true },
    { id: "bulk", label: "Bulk Run", icon: PlayCircle, superAdmin: true },
    { id: "signins", label: "Sign-in Activity", icon: Activity, superAdmin: true },
    { id: "settings", label: "Settings", icon: Settings, superAdmin: true },
  ];

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <aside className="w-[240px] shrink-0 bg-surface border-r border-border flex flex-col">
        <div className="h-14 px-4 flex items-center gap-2 border-b border-border">
          <div className="h-7 w-7 border border-primary/40 flex items-center justify-center rounded-sm">
            <AudioWaveform className="h-3.5 w-3.5 text-primary" />
          </div>
          <span className="font-mono text-xs tracking-widest text-muted-foreground">CX AUDIT</span>
        </div>
        <nav className="flex-1 py-4">
          {nav.filter((n) => (!n.admin || admin) && (!n.superAdmin || superAdmin)).map((n) => {
            const Icon = n.icon;
            const active = view === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setView(n.id)}
                aria-label={n.label}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors duration-150 border-l-2",
                  active
                    ? "border-primary text-primary bg-surface-2"
                    : "border-transparent text-zinc-400 hover:bg-surface-2 hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                <span>{n.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="p-4 border-t border-border">
          <p className="font-mono text-[10px] text-muted-foreground/60">v0.2 · internal</p>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-border flex items-center justify-between px-6 bg-background">
          <h1 className="text-lg font-bold">{VIEW_LABELS[view]}</h1>
          <div className="flex items-center gap-3">
            <span className="text-sm text-foreground">{user.name}</span>
            <span className={cn("font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-sm inline-flex items-center gap-1", roleClass(user.role))}>
              {user.role === "super_admin" && <Crown className="h-3 w-3" />}
              {user.role}
            </span>
            <button
              onClick={onLogout}
              aria-label="Log out"
              className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-auto">
          {view === "calls" && <CallAuditsView user={user} users={users} />}
          {view === "performance" && <PerformanceView user={user} users={users} />}
          {view === "users" && admin && <AgentRosterView user={user} />}
          {view === "teams" && admin && <AuditPromptsView user={user} />}
          {view === "patterns" && superAdmin && <PatternsView user={user} />}
          {view === "bulk" && superAdmin && <BulkRunView user={user} />}
          {view === "signins" && superAdmin && <SignInActivityView user={user} />}
          {view === "settings" && superAdmin && <SettingsView user={user} />}
        </main>
      </div>
    </div>
  );
}
