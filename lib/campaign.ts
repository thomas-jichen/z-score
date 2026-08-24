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
  /**
   * First day that explores instead of searching. Ignored unless the strategy
   * switches, so 2 means "search on day one, follow the graph after".
   */
  switchDay: number;
  /** How many of the best people's co-view lists to open on an exploring day. */
  exploreFrom: number;
  /**
   * How far from a searched person a find may be.
   *
   * The reason there is a cap at all: a co-view is not a similarity model. It
   * reports who browsers looked at in the same session, so each hop is a chance to
   * drift, and two hops out from a well-known adult is a different population
   * entirely. Two is close enough to the archetype to be worth reading.
   */
  maxHop: number;
};

/**
 * How a campaign spends its days.
 *
 * `search` is the original and the default, so nothing already running changes.
 * `search-then-explore` is the shape a person actually uses: cast a wide keyword net
 * to find the archetype, then follow who else people viewed. `explore` skips the net
 * and mines the graph of people already held.
 *
 * A field on the record rather than a setting, because `cleanSettings` coerces every
 * key with `Number()` and `LIMITS` is declared `satisfies Record<keyof
 * CampaignSettings, …>` — settings is numeric by construction, and a string there
 * would break that in five places.
 */
export type CampaignStrategy = "search" | "search-then-explore" | "explore";

export const STRATEGIES: CampaignStrategy[] = ["search", "search-then-explore", "explore"];

export function isStrategy(v: unknown): v is CampaignStrategy {
  return typeof v === "string" && (STRATEGIES as string[]).includes(v);
}

/** Whether a given day of a campaign searches or explores. */
export function daySearches(strategy: CampaignStrategy, day: number, switchDay: number): boolean {
  if (strategy === "search") return true;
  if (strategy === "explore") return false;
  return day < switchDay;
}

/** How many of a campaign's days run queries. Drives the estimate. */
export function searchDayCount(strategy: CampaignStrategy, s: CampaignSettings): number {
  if (strategy === "search") return s.days;
  if (strategy === "explore") return 0;
  return Math.max(0, Math.min(s.days, s.switchDay - 1));
}

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
  queuePerDay: { min: 1, max: 200, fallback: 50 },
  enrichPerDay: { min: 0, max: 100, fallback: 25 },
  budgetUsd: { min: 0, max: 100, fallback: 5 },
  scoreBar: { min: 0, max: 20, fallback: 0 },
  switchDay: { min: 2, max: 30, fallback: 2 },
  exploreFrom: { min: 1, max: 50, fallback: 10 },
  maxHop: { min: 1, max: 5, fallback: 2 },
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
    switchDay: LIMITS.switchDay.fallback,
    exploreFrom: LIMITS.exploreFrom.fallback,
    maxHop: LIMITS.maxHop.fallback,
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
  /** Co-view lists opened. A day that explored reported zero of everything before. */
  explored?: number;
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
  /** How it spends its days. Defaults to `search`, which is what it always did. */
  strategy: CampaignStrategy;

  /** 0 means created and never advanced. */
  day: number;
  /** UTC date of the last advance, so the day counter never depends on wall clock. */
  lastTickDay: string | null;
  queryCursor: number;
  searchedToday: number;
  queuedToday: number;
  enrichedToday: number;
  /**
   * Seeds whose co-view list has been opened, ever, and how many were opened today.
   *
   * The first stops a campaign re-reading the same sidebar on every exploring day.
   * The second is what lets an exploring day be *finished*: `dayDone` was written in
   * terms of `searchedToday`, which never moves on a day that runs no queries, so
   * without this an advance would redo the day's work on every call.
   */
  explored: string[];
  exploredToday: number;
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
  /**
   * When its report was emailed, which is the whole of the idempotency.
   *
   * A campaign can be finished by the nightly cron, by the Advance button or by
   * Claude, and the drain that mails it runs after all three. Recording the send on
   * the campaign rather than tracking it anywhere else means the drain is a query —
   * finished, not yet notified — so it cannot send twice however often it runs, and
   * a send that failed simply has not stamped and is retried on the next pass.
   */
  notifiedAt?: string;
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
export function estimateUsd(s: CampaignSettings, strategy: CampaignStrategy = "search"): number {
  /**
   * Only the days that actually run queries are charged for them, which makes this
   * number honest on an exploring campaign for the first time: a seven-day run that
   * switches on day two searches once, so it is a hundred queries and not seven
   * hundred. A hop itself is free — the co-view list arrived with an enrichment
   * already paid for — so exploring adds nothing to the search line.
   */
  const search = searchDayCount(strategy, s) * s.searchesPerDay * COST_PER_QUERY;
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
  /**
   * An exhausted plan ends a searching campaign and nothing else.
   *
   * For `search` it is the honest answer: there is no work left. For anything that
   * explores it is the *expected* state — burning the whole plan on day one is the
   * point of the shape — and this check firing there would have finished every such
   * campaign on day two, before it followed a single edge.
   */
  // Defaulted, not asserted. A campaign literal built without a strategy — a test
  // fixture, a document written before the field existed — searched, and treating it
  // as anything else would quietly stop applying the rule it was written under.
  if ((c.strategy ?? "search") === "search" && c.queryCursor >= planLength) {
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
    // Anything written before the strategy existed searched, which is what it did.
    strategy: isStrategy(stored.strategy) ? stored.strategy : "search",
    day: stored.day ?? 0,
    lastTickDay: stored.lastTickDay ?? null,
    queryCursor: stored.queryCursor ?? 0,
    searchedToday: stored.searchedToday ?? 0,
    queuedToday: stored.queuedToday ?? 0,
    enrichedToday: stored.enrichedToday ?? 0,
    explored: Array.isArray(stored.explored) ? stored.explored : [],
    exploredToday: stored.exploredToday ?? 0,
    pendingJobId: stored.pendingJobId ?? null,
    spentUsd: stored.spentUsd ?? 0,
    top: Array.isArray(stored.top) ? stored.top : [],
    found: Array.isArray(stored.found) ? stored.found : [],
    foundCount: stored.foundCount ?? (stored.found?.length ?? 0),
    ticks: Array.isArray(stored.ticks) ? stored.ticks : [],
    createdAt: stored.createdAt ?? new Date().toISOString(),
    lastTickAt: stored.lastTickAt,
    finishedAt: stored.finishedAt,
    notifiedAt: stored.notifiedAt,
  };
}

/**
 * What a day did, in words, for whichever surface is printing it.
 *
 * One function because there are three of them — the Agent screen twice and the MCP
 * once — and a day that followed the graph reported "0 queries" in all three.
 */
export function tickWork(t: { queries: number; explored?: number }): string {
  const parts: string[] = [];
  if (t.queries > 0) parts.push(`${t.queries} ${t.queries === 1 ? "query" : "queries"}`);
  if (t.explored) {
    parts.push(`${t.explored} co-view ${t.explored === 1 ? "list" : "lists"}`);
  }
  if (parts.length === 0) parts.push("nothing to run");
  return parts.join(" and ");
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
    // Every setting, not the two the row happens to print. The screen has to be able
    // to change every one of them, and it can only offer what it was sent.
    settings: c.settings,
    strategy: c.strategy,
    spentUsd: Number(c.spentUsd.toFixed(4)),
    foundCount: c.foundCount,
    lastTickAt: c.lastTickAt,
    createdAt: c.createdAt,
  };
}
