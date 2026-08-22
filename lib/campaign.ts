import type { Archetype } from "./clusters";
import { COST_PER_PROFILE } from "./enrichment";
import type { ProfileId } from "./profiles";
import { COST_PER_QUERY, EMPTY_SELECTION, type Selection } from "./query";

/**
 * A campaign: a search that runs itself for a few days.
 *
 * ── Nothing here is a black box ───────────────────────────────────────────
 * Every number the loop obeys is a field on the record or a row in `LIMITS`
 * below, which means every number is visible on the Agent screen and settable
 * from either side — the page or Claude. There is deliberately no constant buried
 * in the engine that decides how much a campaign searches, queues, spends or
 * demands of a candidate. A loop that runs unattended for a week and cannot be
 * asked why it stopped is not something anybody should be expected to trust.
 */

/** The six knobs. All editable at any time, including mid-run. */
export type CampaignSettings = {
  /** Calendar days the campaign advances through before finishing. */
  days: number;
  /** Google queries a day. One costs COST_PER_QUERY. */
  searchesPerDay: number;
  /**
   * People a day allowed into the roster.
   *
   * This, not the score bar, is the overflow guard. A search-only person scores
   * close to zero — `scoreOne` has almost nothing to read before enrichment — so
   * a threshold high enough to filter would reject everybody. Ranking and taking
   * a fixed number cannot silently evaluate to nobody.
   */
  queuePerDay: number;
  /** Profiles a day to pay for. Zero is a legitimate setting. */
  enrichPerDay: number;
  /** Hard ceiling. The campaign finishes when it is reached, it does not aim for it. */
  budgetUsd: number;
  /**
   * Optional extra filter on top of the ranking, in score points.
   *
   * Defaults to zero because it is a bonus constraint, not the gate. Raise it
   * only when the queue is filling with people you would not have clicked.
   */
  scoreBar: number;
};

/**
 * The bounds, as data.
 *
 * Exported so the Agent screen can render the real minimum, maximum and default
 * beside every field, and so the MCP tools can tell Claude what it is allowed to
 * ask for instead of guessing and being rejected.
 */
export const LIMITS = {
  days: { min: 1, max: 30, fallback: 7 },
  searchesPerDay: { min: 1, max: 200, fallback: 100 },
  queuePerDay: { min: 1, max: 200, fallback: 40 },
  enrichPerDay: { min: 0, max: 100, fallback: 10 },
  budgetUsd: { min: 0, max: 100, fallback: 5 },
  scoreBar: { min: 0, max: 7, fallback: 0 },
} as const satisfies Record<keyof CampaignSettings, { min: number; max: number; fallback: number }>;

export const SETTING_KEYS = Object.keys(LIMITS) as (keyof CampaignSettings)[];

export function defaultSettings(): CampaignSettings {
  return {
    days: LIMITS.days.fallback,
    searchesPerDay: LIMITS.searchesPerDay.fallback,
    queuePerDay: LIMITS.queuePerDay.fallback,
    enrichPerDay: LIMITS.enrichPerDay.fallback,
    budgetUsd: LIMITS.budgetUsd.fallback,
    scoreBar: LIMITS.scoreBar.fallback,
  };
}

/** Clamped rather than rejected, so a number out of range is corrected and reported. */
export function cleanSettings(
  raw: Partial<Record<keyof CampaignSettings, unknown>> | undefined,
  base: CampaignSettings
): CampaignSettings {
  const out = { ...base };
  for (const key of SETTING_KEYS) {
    const given = raw?.[key];
    if (given === undefined || given === null || given === "") continue;
    const n = Number(given);
    if (!Number.isFinite(n)) continue;
    const { min, max } = LIMITS[key];
    // Whole numbers everywhere except money and the score bar, which are decimal.
    const stepped = key === "budgetUsd" || key === "scoreBar" ? n : Math.round(n);
    out[key] = Math.min(Math.max(stepped, min), max);
  }
  return out;
}

/**
 * A person the campaign surfaced, recorded as it found them.
 *
 * A snapshot rather than a pointer into the roster, because the roster evicts the
 * oldest non-pinned non-enriched first at MAX_PEOPLE — so a campaign's own day-one
 * finds can be gone before its report runs. Read back, rows still in the roster
 * are re-scored from live data so someone enriched later shows their real score,
 * and the rest fall back to what was true when they were found.
 */
export type ReportRow = {
  slug: string;
  name: string;
  headline: string;
  url: string;
  score: number;
  archetype: Archetype;
  /** Which of the campaign's own search terms this person's text actually backs up. */
  confirmed: string[];
  enriched: boolean;
  day: number;
  at: string;
};

export type Tick = {
  at: string;
  day: number;
  queries: number;
  hits: number;
  queued: number;
  enriched: number;
  tagged: number;
  usd: number;
  /** Anything that went wrong or ran short, in words a person can act on. */
  note?: string;
};

export type CampaignStatus = "running" | "done" | "stopped";

export type Campaign = {
  id: string;
  owner: ProfileId;
  name: string;
  status: CampaignStatus;
  /** Why it is no longer running, in words. Empty while running. */
  finishedReason?: string;

  selection: Selection;
  /** Hand-written queries, which the menus cannot express. */
  queries: string[];
  settings: CampaignSettings;

  /** 0 means created and never advanced. */
  day: number;
  /** UTC date of the last advance, so the day counter never depends on wall clock. */
  lastTickDay: string | null;
  queryCursor: number;
  searchedToday: number;
  queuedToday: number;
  enrichedToday: number;
  /** An enrichment run a previous tick could not wait out. Drained first, always. */
  pendingJobId: string | null;

  spentUsd: number;
  /** The best of what it found, capped. */
  top: ReportRow[];
  /** Newest first, capped. `foundCount` is the honest total. */
  found: string[];
  foundCount: number;
  ticks: Tick[];

  createdAt: string;
  lastTickAt?: string;
  finishedAt?: string;
};

export const CAMPAIGNS_KEY = "zscore:team:campaigns";
export const AGENT_KEY = "zscore:team:agent";

/** Bounds on the record itself, so one campaign cannot grow without limit. */
export const KEEP_TOP = 30;
export const KEEP_FOUND = 500;
export const KEEP_TICKS = 30;
export const MAX_CAMPAIGNS = 25;

export function newCampaignId(): string {
  return `cmp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** UTC, because the day counter must not move when somebody travels. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * What a campaign costs to run to completion, at today's vendor prices.
 *
 * Shown at creation so a ceiling is set against a real number rather than a
 * guess, and so "why did it stop on day four" has an answer before day one.
 */
export function estimateUsd(s: CampaignSettings): number {
  const search = s.days * s.searchesPerDay * COST_PER_QUERY;
  const enrich = s.days * s.enrichPerDay * COST_PER_PROFILE;
  return Number((search + enrich).toFixed(4));
}

/**
 * Why this campaign should stop, or null to carry on.
 *
 * Every exit returns words rather than a code, because this string is what the
 * report shows and what Claude reads back when asked how it went.
 */
export function terminalReason(c: Campaign, planLength: number): string | null {
  if (c.day > c.settings.days) {
    return `ran its full ${c.settings.days} ${c.settings.days === 1 ? "day" : "days"}`;
  }
  if (c.settings.budgetUsd > 0 && c.spentUsd >= c.settings.budgetUsd) {
    return `reached its ${c.settings.budgetUsd.toFixed(2)} dollar ceiling`;
  }
  if (c.queryCursor >= planLength) {
    return `ran out of queries, ${planLength} of ${planLength} used, so the selection was narrower than the schedule`;
  }
  return null;
}

/** Room left before the ceiling. `Infinity` when no ceiling was set. */
export function budgetLeft(c: Campaign): number {
  if (c.settings.budgetUsd <= 0) return Infinity;
  return Math.max(0, c.settings.budgetUsd - c.spentUsd);
}

/**
 * Fold new finds into the kept best, highest score first.
 *
 * Re-sorted on every merge rather than appended, so the thirty kept are the best
 * thirty seen and not the first thirty seen.
 */
export function mergeTop(existing: ReportRow[], incoming: ReportRow[], keep = KEEP_TOP): ReportRow[] {
  const byslug = new Map(existing.map((r) => [r.slug, r]));
  for (const row of incoming) {
    const prev = byslug.get(row.slug);
    // A later sighting knows more: it may have been enriched since.
    if (!prev || row.score >= prev.score) byslug.set(row.slug, row);
  }
  return [...byslug.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, keep);
}

/** Fill in anything a stored record is missing, so an older write stays readable. */
export function hydrateCampaign(stored: Partial<Campaign> | null): Campaign | null {
  if (!stored?.id || !stored.owner) return null;
  return {
    id: stored.id,
    owner: stored.owner,
    name: stored.name ?? "Untitled",
    status: stored.status ?? "running",
    finishedReason: stored.finishedReason,
    selection: { ...EMPTY_SELECTION, ...(stored.selection ?? {}) },
    queries: Array.isArray(stored.queries) ? stored.queries : [],
    settings: cleanSettings(stored.settings, defaultSettings()),
    day: stored.day ?? 0,
    lastTickDay: stored.lastTickDay ?? null,
    queryCursor: stored.queryCursor ?? 0,
    searchedToday: stored.searchedToday ?? 0,
    queuedToday: stored.queuedToday ?? 0,
    enrichedToday: stored.enrichedToday ?? 0,
    pendingJobId: stored.pendingJobId ?? null,
    spentUsd: stored.spentUsd ?? 0,
    top: Array.isArray(stored.top) ? stored.top : [],
    found: Array.isArray(stored.found) ? stored.found : [],
    foundCount: stored.foundCount ?? (stored.found?.length ?? 0),
    ticks: Array.isArray(stored.ticks) ? stored.ticks : [],
    createdAt: stored.createdAt ?? new Date().toISOString(),
    lastTickAt: stored.lastTickAt,
    finishedAt: stored.finishedAt,
  };
}

/** The one-line shape the list views and the MCP both want. */
export function summarise(c: Campaign) {
  return {
    id: c.id,
    name: c.name,
    owner: c.owner,
    status: c.status,
    finishedReason: c.finishedReason,
    day: c.day,
    // All six, not the two the row happens to print. The screen has to be able
    // to change every one of them, and it can only offer what it was sent.
    settings: c.settings,
    spentUsd: Number(c.spentUsd.toFixed(4)),
    foundCount: c.foundCount,
    lastTickAt: c.lastTickAt,
    createdAt: c.createdAt,
  };
}
