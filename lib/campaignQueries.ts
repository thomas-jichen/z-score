import { EMPTY_SELECTION, SITE_FILTER, buildQuery, type Selection } from "./query";

/**
 * Every query a campaign will run, in the order to run them.
 *
 * ── Why not a cross-product ───────────────────────────────────────────────
 * `buildQuery` joins its groups by juxtaposition, which Google reads as AND. So
 * the full cross-product of a seven-category selection emits
 *
 *   RSI TJHSST Stanford 2030 California Founder site:linkedin.com/in
 *
 * and finds nobody. The failure mode of a cross-product here is over-constraint,
 * not combinatorial explosion — you would pay for seven hundred queries and get
 * seven hundred empty result sets. So this bounds the *arity* of a query rather
 * than the count of them.
 *
 * ── Why it is not stored ──────────────────────────────────────────────────
 * Pure and cheap, so the campaign holds its `Selection` and one integer cursor
 * and regenerates this each tick. A cursor also beats rotating a window by day:
 * rotation silently repeats once the plan is shorter than days × searchesPerDay,
 * and it hides the fact that the plan ran out.
 *
 * Widest-yield first, so a campaign that stops early stopped after the good ones
 * and the three-term tail that returns nothing is the part never reached.
 */

/** Specific enough to be worth searching on its own. */
const ANCHORS = ["programs", "colleges", "highSchools"] as const;

/**
 * Only useful for narrowing an anchor. "Founder site:linkedin.com/in" is not a
 * search, it is most of LinkedIn.
 */
const MODIFIERS = ["titles", "years", "states", "homeStates"] as const;

/** Enough for a month at two hundred a day, and it bounds the work here. */
export const MAX_PLAN = 4000;

type Cell = { key: keyof Selection; value: string };

function cells(sel: Selection, keys: readonly (keyof Selection)[]): Cell[] {
  const out: Cell[] = [];
  for (const key of keys) {
    for (const value of sel[key] ?? []) {
      const v = value.trim();
      if (v) out.push({ key, value: v });
    }
  }
  return out;
}

/**
 * One value from each named category, through the real builder.
 *
 * Going through `buildQuery` rather than joining strings keeps `SPELL_OUT`, the
 * group order and the site filter in exactly one place — so the acronym fix that
 * stopped TJHSST matching "T.J. Parker" applies to campaign queries too, for free.
 */
function compose(...cs: Cell[]): string {
  const sel: Selection = { ...EMPTY_SELECTION };
  for (const c of cs) sel[c.key] = [...sel[c.key], c.value];
  return buildQuery(sel);
}

/** An operator's own query, made safe to send without second-guessing the rest of it. */
function raw(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (!t) return "";
  // Their `site:` wins. Ours is only added when they did not scope it themselves.
  return /\bsite:/i.test(t) ? t : `${t} ${SITE_FILTER}`;
}

export function planQueries(
  sel: Selection,
  extra: string[] = [],
  limit: number = MAX_PLAN
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    if (!s || out.length >= limit) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  // 1. What was asked for, verbatim. Nothing generated beats a hand-written query.
  for (const s of extra) add(raw(s));

  const anchors = cells(sel, ANCHORS);
  const mods = cells(sel, MODIFIERS);

  // 2. Each anchor alone. The broadest useful shape, and the only one that works
  //    when the selection names a single thing.
  for (const a of anchors) add(compose(a));

  // 3. Anchor by modifier. One anchor, sliced several ways.
  for (const a of anchors) for (const m of mods) add(compose(a, m));

  // 4. Anchor by anchor, across categories only. "TJHSST Stanford" is a real
  //    question; two programmes in one query usually is not.
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      if (anchors[i].key !== anchors[j].key) add(compose(anchors[i], anchors[j]));
    }
  }

  // 5. Anchor by two modifiers, last, because three AND-ed groups is where a
  //    query stops returning anything.
  for (const a of anchors) {
    for (let i = 0; i < mods.length; i++) {
      for (let j = i + 1; j < mods.length; j++) {
        if (mods[i].key !== mods[j].key) add(compose(a, mods[i], mods[j]));
      }
    }
  }

  return out;
}

/**
 * The slice a given day should run.
 *
 * Takes the cursor rather than the day number, because a tick that ran out of
 * time mid-day must resume where it stopped and not re-pay for what it already
 * ran. Returns fewer than `count` when the plan is exhausted, which is how the
 * caller learns to finish the campaign.
 */
export function queriesFrom(plan: string[], cursor: number, count: number): string[] {
  if (cursor >= plan.length || count <= 0) return [];
  return plan.slice(cursor, cursor + count);
}
