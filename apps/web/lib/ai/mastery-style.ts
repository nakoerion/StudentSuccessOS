/** Mastery colour scale, shared by the server page (legend, summary) and the client grid. */
export type HeatLevel = "low" | "developing" | "secure" | "strong";

export const LEVEL_CLASS: Record<HeatLevel, string> = {
  low: "bg-rose-600 text-white",
  developing: "bg-amber-400 text-amber-950",
  secure: "bg-lime-400 text-lime-950",
  strong: "bg-emerald-600 text-white",
};

/** "No data" is hatched and dashed so it can never be mistaken for a low score. */
export const NO_DATA_CLASS =
  "border border-dashed border-muted-foreground/50 bg-[repeating-linear-gradient(135deg,transparent_0_6px,var(--muted)_6px_8px)] text-muted-foreground";
