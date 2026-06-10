import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AuthScreen } from "@/components/cx/AuthScreen";
import { DashboardShell } from "@/components/cx/DashboardShell";
import { clearToken } from "@/lib/api";
import type { User } from "@/lib/cx-data";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "CX Audit Console" },
      { name: "description", content: "Internal CX call audit dashboard." },
    ],
  }),
  component: Index,
});

function Index() {
  const [user, setUser] = useState<User | null>(null);
  if (!user) return <AuthScreen onLogin={setUser} />;
  return (
    <DashboardShell
      user={user}
      onLogout={() => {
        clearToken();
        setUser(null);
      }}
    />
  );
}
