// The severity filter (`f h`, `f m`, `f a`): which findings the reader sees. It is for reading, not for what gets posted:
// a filtered-out finding leaves the gutter, the rail, the counts and the go-to keys, but the submit checklist still lists
// every finding. The level is kept with the stored review (build.ts), never in the document. Pure, so it is tested without a screen.

import type { Finding, Severity } from "./guide.ts";

export type Filter = "high" | "medium" | "all";
export const FILTERS: readonly Filter[] = ["high", "medium", "all"];
export const DEFAULT_FILTER: Filter = "all";

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const LIMIT: Record<Filter, number> = { high: 0, medium: 1, all: 2 };

/** A stored value read back: anything that is not a filter is the default. */
export const filterOf = (v: unknown): Filter => (FILTERS as readonly unknown[]).includes(v) ? (v as Filter) : DEFAULT_FILTER;

/** Whether a finding of this severity is shown at this level. */
export const shownAt = (severity: Severity, level: Filter): boolean => RANK[severity] <= LIMIT[level];

/** The findings the level shows. */
export const filtered = <T extends Pick<Finding, "severity">>(findings: T[], level: Filter): T[] => findings.filter((f) => shownAt(f.severity, level));

/** The level as the status area and the notes word it. */
export const filterLabel = (level: Filter): string => level === "high" ? "high only" : level === "medium" ? "high and medium" : "all";

/** The submit checklist's header note: empty while every finding is shown, else that the filter is for reading only. */
export const checklistNote = (level: Filter): string => level === "all" ? "" : `The filter (${filterLabel(level)}) is only for reading: every finding is listed here.`;
