import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type User,
  type Role,
  type Team,
  TEAMS,
  roleClass,
  teamClass,
} from "@/lib/cx-data";
import { fetchUsers, createUser, updateUser, deleteUser, type NewUser } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function AgentRosterView({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const isSuper = user.role === "super_admin";
  const [dialog, setDialog] = useState<{ mode: "add" | "edit"; target: User | null } | null>(null);
  const [error, setError] = useState("");

  const { data: users = [], isLoading } = useQuery<User[]>({ queryKey: ["users"], queryFn: fetchUsers });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["users"] });
  const onError = (e: unknown) => setError(e instanceof Error ? e.message : "Request failed.");

  const createMut = useMutation({ mutationFn: createUser, onSuccess: () => { invalidate(); setDialog(null); }, onError });
  const updateMut = useMutation({
    mutationFn: (v: { id: string; patch: Partial<User> }) => updateUser(v.id, v.patch),
    onSuccess: () => { invalidate(); setDialog(null); },
    onError,
  });
  const deleteMut = useMutation({ mutationFn: deleteUser, onSuccess: invalidate, onError });

  // Admins can only manage plain users in their own team.
  const canManage = (target: User) =>
    isSuper || (target.role === "user" && target.team === user.team && target.user_id !== user.user_id);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <p className="font-mono text-xs text-muted-foreground">
          {users.length} users · {users.filter((u) => u.status === "active").length} active
        </p>
        <Button onClick={() => { setError(""); setDialog({ mode: "add", target: null }); }} className="bg-primary text-primary-foreground hover:bg-primary/90">
          <Plus className="h-3.5 w-3.5 mr-1.5" /> Add User
        </Button>
      </div>

      {error && <div className="mb-4 border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 rounded-sm font-mono text-xs">{error}</div>}

      <div className="border border-border rounded-md overflow-hidden bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-background">
              {["Name", "Email", "Agent ID", "Team", "Role", "Status", "Actions"].map((h) => (
                <th key={h} className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground text-left px-3 py-2.5 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={7} className="px-3 py-12 text-center font-mono text-xs text-muted-foreground">Loading users…</td></tr>}
            {users.map((u) => (
              <tr key={u.user_id} className="border-b border-border last:border-0 hover:bg-surface-2 transition-colors">
                <td className="px-3 py-3">{u.name}</td>
                <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{u.email}</td>
                <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{u.agent_id ?? "—"}</td>
                <td className="px-3 py-3">
                  <span className={cn("font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-sm", teamClass(u.team))}>{u.team ?? "—"}</span>
                </td>
                <td className="px-3 py-3">
                  <span className={cn("font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-sm", roleClass(u.role))}>{u.role}</span>
                </td>
                <td className="px-3 py-3">
                  <span className={cn("font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full", u.status === "active" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-muted text-muted-foreground border-border")}>{u.status}</span>
                </td>
                <td className="px-3 py-3">
                  <div className="flex gap-1">
                    <button
                      disabled={!canManage(u)}
                      onClick={() => { setError(""); setDialog({ mode: "edit", target: u }); }}
                      aria-label="Edit user"
                      className="p-1.5 rounded-sm hover:bg-background text-muted-foreground hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed"
                    ><Pencil className="h-3.5 w-3.5" /></button>
                    <button
                      disabled={!canManage(u) || deleteMut.isPending}
                      onClick={() => canManage(u) && deleteMut.mutate(u.user_id)}
                      aria-label="Remove user"
                      className="p-1.5 rounded-sm hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:cursor-not-allowed"
                    ><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dialog && (
        <UserDialog
          mode={dialog.mode}
          target={dialog.target}
          isSuper={isSuper}
          actorTeam={user.team}
          submitting={createMut.isPending || updateMut.isPending}
          onClose={() => setDialog(null)}
          onSubmit={(payload) => {
            if (dialog.mode === "add") createMut.mutate(payload as NewUser);
            else updateMut.mutate({ id: dialog.target!.user_id, patch: payload });
          }}
        />
      )}
    </div>
  );
}

function UserDialog({
  mode, target, isSuper, actorTeam, submitting, onClose, onSubmit,
}: {
  mode: "add" | "edit";
  target: User | null;
  isSuper: boolean;
  actorTeam: Team | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (payload: Partial<User> & NewUser) => void;
}) {
  const [form, setForm] = useState({
    email: target?.email ?? "",
    name: target?.name ?? "",
    role: (target?.role ?? "user") as Role,
    team: (target?.team ?? actorTeam ?? "CS") as Team,
    agent_id: target?.agent_id ?? "",
    status: (target?.status ?? "active") as User["status"],
  });
  const [errs, setErrs] = useState<Record<string, string>>({});

  // Admins can only assign the `user` role; super_admins can assign any.
  const roleOptions: Role[] = isSuper ? ["super_admin", "admin", "user"] : ["user"];

  const submit = () => {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = "Required";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "Invalid email";
    setErrs(e);
    if (Object.keys(e).length) return;
    onSubmit({
      email: form.email.trim(),
      name: form.name.trim(),
      role: form.role,
      team: form.role === "super_admin" ? null : form.team,
      agent_id: form.agent_id.trim() || null,
      status: form.status,
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="bg-surface border-border max-w-md">
        <DialogHeader><DialogTitle>{mode === "add" ? "Add User" : "Edit User"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field label="Full Name" error={errs.name}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="bg-background border-border" />
          </Field>
          <Field label="Email" error={errs.email}>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} disabled={mode === "edit"} className="font-mono bg-background border-border" />
          </Field>
          <Field label="Agent ID (dialer)">
            <Input value={form.agent_id} onChange={(e) => setForm({ ...form, agent_id: e.target.value })} placeholder="e.g. 495367" className="font-mono bg-background border-border" />
          </Field>
          <Field label="Role">
            <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as Role })} disabled={!isSuper}>
              <SelectTrigger className="bg-background border-border"><SelectValue /></SelectTrigger>
              <SelectContent>{roleOptions.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {form.role !== "super_admin" && (
            <Field label="Team">
              <Select value={form.team} onValueChange={(v) => setForm({ ...form, team: v as Team })} disabled={!isSuper}>
                <SelectTrigger className="bg-background border-border"><SelectValue /></SelectTrigger>
                <SelectContent>{TEAMS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          )}
          {mode === "edit" && (
            <Field label="Status">
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as User["status"] })}>
                <SelectTrigger className="bg-background border-border"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">active</SelectItem>
                  <SelectItem value="inactive">inactive</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} className="border border-border">Cancel</Button>
          <Button onClick={submit} disabled={submitting} className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {submitting ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</label>
      <div className="mt-1">{children}</div>
      {error && <p className="font-mono text-xs text-destructive mt-1">{error}</p>}
    </div>
  );
}
