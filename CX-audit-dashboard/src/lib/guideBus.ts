/**
 * A one-way channel from the guide tour to the views it walks through.
 *
 * Several things the tour needs to point at do not exist in the DOM until a
 * section is expanded — Improvement Suggestions is collapsed by default, an
 * additional rubric's fields only mount when its row is open, and the new-team
 * form only appears after clicking "New". Anchoring inside those requires the
 * view to open them first.
 *
 * A tiny module-level bus keeps that decoupled: the tour emits a signal, any
 * view that cares subscribes. No prop drilling through DashboardShell, and no
 * imperative refs reaching into child components.
 */

export type GuideSignal =
  | "open-new-team-form"
  | "expand-suggestions"
  | "expand-first-rubric";

type Listener = (signal: GuideSignal) => void;

const listeners = new Set<Listener>();

/** Subscribe to guide signals. Returns an unsubscribe function. */
export function onGuideSignal(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Ask any listening view to reveal something. Safe to call with no listeners. */
export function emitGuideSignal(signal: GuideSignal): void {
  for (const fn of listeners) fn(signal);
}
