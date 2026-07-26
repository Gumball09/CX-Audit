import { useState } from "react";
import { HelpCircle, Play } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { guidesFor, stepsFor, type Guide, type GuideRole } from "@/lib/guides";

/**
 * Header entry point for the guided tours. Lists only the guides the current
 * role can run, with the step count they will actually get after per-step role
 * filtering — so an admin doesn't see a promised 10 steps and receive 6.
 */
export function GuideMenu({ role, onStart }: { role: GuideRole; onStart: (guide: Guide) => void }) {
  const [open, setOpen] = useState(false);
  const guides = guidesFor(role);

  if (guides.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          data-guide="guide-menu"
          aria-label="Guided tours"
          className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors"
        >
          <HelpCircle className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-0 bg-surface border-border">
        <div className="px-3 py-2.5 border-b border-border">
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Guided tours</p>
          <p className="text-[11px] text-muted-foreground/80 mt-1">
            Walks you through the real screen, one control at a time.
          </p>
        </div>
        <ul className="max-h-[380px] overflow-auto py-1">
          {guides.map((g) => {
            const count = stepsFor(g, role).length;
            return (
              <li key={g.id}>
                <button
                  onClick={() => {
                    setOpen(false);
                    onStart(g);
                  }}
                  className="w-full text-left px-3 py-2.5 hover:bg-surface-2 transition-colors group"
                >
                  <div className="flex items-center gap-2">
                    <Play className="h-3 w-3 text-muted-foreground group-hover:text-primary shrink-0" />
                    <span className="text-xs text-foreground">{g.name}</span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground shrink-0">{count} steps</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground/75 mt-1 pl-5 leading-relaxed">{g.description}</p>
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
