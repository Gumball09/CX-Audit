import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { emitGuideSignal } from "@/lib/guideBus";
import { stepsFor, type Guide, type GuideRole, type GuideStep, type View } from "@/lib/guides";
import { cn } from "@/lib/utils";

/** Gap between the spotlight and the tooltip, and the tooltip's fixed width. */
const GAP = 12;
const CARD_W = 380;
/** How long to keep looking for an anchor before giving up on it. */
const FIND_TIMEOUT_MS = 700;
const FIND_INTERVAL_MS = 50;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const findAnchor = (anchor: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-guide="${anchor}"]`);

const rectOf = (el: HTMLElement): Rect => {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
};

export function GuideTour({
  guide,
  role,
  currentView,
  onNavigate,
  onClose,
}: {
  guide: Guide;
  role: GuideRole;
  currentView: View;
  onNavigate: (view: View) => void;
  onClose: () => void;
}) {
  const steps = useMemo(() => stepsFor(guide, role), [guide, role]);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  /** True while we're still hunting for the current step's anchor. */
  const [locating, setLocating] = useState(true);
  const cardRef = useRef<HTMLDivElement>(null);

  const step: GuideStep | undefined = steps[index];
  const total = steps.length;

  const next = useCallback(() => setIndex((i) => Math.min(i + 1, total - 1)), [total]);
  const back = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);
  const isLast = index >= total - 1;

  // Switch view as soon as the step changes, so the DOM has a chance to mount
  // before we start looking for the anchor.
  useEffect(() => {
    if (!step) return;
    if (step.view && step.view !== currentView) onNavigate(step.view);
    // currentView is deliberately omitted: re-running on the view change it just
    // caused would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, index]);

  // Locate the anchor, retrying while the view mounts. An `optional` step whose
  // anchor never appears is skipped; a required one falls back to a centered card.
  useEffect(() => {
    if (!step) return;
    let cancelled = false;

    if (!step.anchor) {
      setRect(null);
      setLocating(false);
      return;
    }

    setLocating(true);
    const startedAt = Date.now();

    const attempt = () => {
      if (cancelled) return;
      // Re-emit each attempt rather than once up front. When a step both switches
      // view and needs a section expanded, the target view hasn't mounted (and so
      // hasn't subscribed) at the moment the step changes — a single emit would
      // be delivered to nobody. Repeating until the anchor appears closes that
      // race, and the listeners are idempotent.
      if (step.signal) emitGuideSignal(step.signal);
      const el = findAnchor(step.anchor!);
      if (el) {
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        // Measure after the smooth scroll has had a moment to settle.
        window.setTimeout(() => {
          if (cancelled) return;
          const still = findAnchor(step.anchor!);
          setRect(still ? rectOf(still) : null);
          setLocating(false);
        }, 260);
        return;
      }
      if (Date.now() - startedAt >= FIND_TIMEOUT_MS) {
        if (import.meta.env.DEV) {
          console.warn(
            `[guide] "${guide.id}" step ${index + 1}: no element with [data-guide="${step.anchor}"]` +
              (step.optional ? " — optional, skipping." : " — showing a centered card instead.")
          );
        }
        if (step.optional && !isLast) {
          setIndex((i) => i + 1);
          return;
        }
        setRect(null);
        setLocating(false);
        return;
      }
      window.setTimeout(attempt, FIND_INTERVAL_MS);
    };

    attempt();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, index]);

  // Keep the spotlight glued to the element as the page scrolls or resizes.
  useEffect(() => {
    if (!step?.anchor || locating) return;
    const reposition = () => {
      const el = findAnchor(step.anchor!);
      if (el) setRect(rectOf(el));
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [step, locating]);

  // Esc exits, arrows navigate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, back, onClose]);

  useEffect(() => {
    cardRef.current?.focus();
  }, [index]);

  if (!step || total === 0) return null;

  const card = cardPosition(rect, step.placement);

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label={`${guide.name} — guided tour`}>
      {/* Spotlight. A huge box-shadow spread dims everything except the cut-out,
          so there is only ever one element to keep in sync with the target. */}
      {rect ? (
        <div
          className="absolute rounded-md pointer-events-none transition-all duration-200 ease-out"
          style={{
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.72)",
            outline: "2px solid var(--primary)",
            outlineOffset: 0,
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/72" />
      )}

      {/* Swallow clicks so the tour drives the flow, not stray interaction. */}
      <div className="absolute inset-0" onClick={(e) => e.stopPropagation()} />

      <div
        ref={cardRef}
        tabIndex={-1}
        className={cn(
          "absolute bg-surface border border-border rounded-md shadow-2xl p-4 outline-none",
          "transition-all duration-200 ease-out"
        )}
        style={{ width: CARD_W, ...card }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wider text-primary">{guide.name}</p>
            <h3 className="text-sm font-semibold text-foreground mt-1">{step.title}</h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close guide"
            className="p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-surface-2"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <p className="mt-2 text-xs leading-relaxed text-foreground/85">{step.body}</p>

        <div className="mt-4 flex items-center justify-between">
          <span className="font-mono text-[10px] text-muted-foreground">
            Step {index + 1} of {total}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={back}
              disabled={index === 0}
              className="h-7 border border-border text-xs disabled:opacity-40"
            >
              <ChevronLeft className="h-3 w-3 mr-1" />
              Back
            </Button>
            {isLast ? (
              <Button
                onClick={onClose}
                className="h-7 bg-primary text-primary-foreground hover:bg-primary/90 text-xs"
              >
                Done
              </Button>
            ) : (
              <Button
                onClick={next}
                className="h-7 bg-primary text-primary-foreground hover:bg-primary/90 text-xs"
              >
                Next
                <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            )}
          </div>
        </div>

        <div className="mt-3 h-0.5 bg-border rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-200"
            style={{ width: `${((index + 1) / total) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Place the card beside the spotlight, flipping to the opposite side when there
 * isn't room and clamping to the viewport so it is never partly off-screen.
 * With no rect (anchorless or unfound step) it sits centered.
 */
function cardPosition(
  rect: Rect | null,
  preferred: GuideStep["placement"] = "bottom"
): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const estH = 210; // enough for title + body + controls

  if (!rect) {
    return { top: Math.max(GAP, vh / 2 - estH / 2), left: Math.max(GAP, vw / 2 - CARD_W / 2) };
  }

  const room = {
    top: rect.top,
    bottom: vh - (rect.top + rect.height),
    left: rect.left,
    right: vw - (rect.left + rect.width),
  };

  let side = preferred;
  const needs = side === "top" || side === "bottom" ? estH + GAP : CARD_W + GAP;
  if (room[side] < needs) {
    const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" } as const;
    const flipped = opposite[side];
    const flippedNeeds = flipped === "top" || flipped === "bottom" ? estH + GAP : CARD_W + GAP;
    if (room[flipped] >= flippedNeeds) side = flipped;
    else side = room.bottom >= room.top ? "bottom" : "top";
  }

  let top: number;
  let left: number;
  switch (side) {
    case "top":
      top = rect.top - estH - GAP;
      left = rect.left + rect.width / 2 - CARD_W / 2;
      break;
    case "bottom":
      top = rect.top + rect.height + GAP;
      left = rect.left + rect.width / 2 - CARD_W / 2;
      break;
    case "left":
      top = rect.top + rect.height / 2 - estH / 2;
      left = rect.left - CARD_W - GAP;
      break;
    default:
      top = rect.top + rect.height / 2 - estH / 2;
      left = rect.left + rect.width + GAP;
  }

  return {
    top: Math.min(Math.max(GAP, top), Math.max(GAP, vh - estH - GAP)),
    left: Math.min(Math.max(GAP, left), Math.max(GAP, vw - CARD_W - GAP)),
  };
}
