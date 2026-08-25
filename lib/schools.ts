import { suggestSchool } from "./groq";
import { log } from "./log";
import type { Person } from "./people";
import type { ProfileId } from "./profiles";
import { reserveTagging } from "./ratelimit";
import { readRoster, readTeam } from "./serverState";
import { TEAM_KEY } from "./state";
import { set } from "./store";
import {
  addAlias,
  indexRegistry,
  makeTag,
  normalizeKey,
  resolveTag,
  type TagFacet,
} from "./tagRegistry";
import { unmatchedTerms } from "./tags";
import { aliasesToLearn } from "./team";
import { isHighSchool } from "./enrichment";

/**
 * What the app learns without being asked.
 *
 * Its own module rather than a private helper in the tagging route, for the reason
 * `aliasesToLearn` is: the decision is the part worth arguing about and the part worth
 * testing, and a function only reachable through an HTTP handler is neither.
 */

/**
 * Learn where a school is, once, and let it be a tag.
 *
 * ── Zero weight is the whole design ───────────────────────────────────────
 * A learned school is written `promoted: false` at weight 0, and that is load-bearing
 * in both directions. `matchedTerms` skips anything unpromoted, so **no score moves** —
 * this feature does not get to decide that Cerritos College is worth points, and a
 * human can promote it on the taxonomy screen if they disagree. But `allTags` keeps
 * unpromoted tags on purpose, its comment noting that "holding a tag at zero weight is
 * a statement about scoring" — so the school still becomes a graph hub, and
 * `schoolStateLookup` can still answer with its state.
 *
 * ── Why it cannot mint a twin ─────────────────────────────────────────────
 * `resolveTag` answers `possible` for a near-duplicate by bigram similarity, and that
 * is what stops "Phillips Academy" becoming a second Phillips Andover. A machine is
 * exactly who should not be deciding whether two school names are one school.
 *
 * ── Why a refusal is recorded ─────────────────────────────────────────────
 * The education section is not only schools. Left unrecorded, Inspirit AI and Yale
 * Young Global Scholars would be asked about on every tagging run forever.
 */
const MAX_AUTO_SCHOOLS = 12;

export async function autoSchools(
  people: Person[],
  owner: ProfileId,
  deadline = Date.now() + 60_000
): Promise<number> {
  const fresh = await readTeam();
  const index = indexRegistry(fresh.taxonomy.tags);
  const declined = new Set(fresh.taxonomy.dismissed.map((d) => normalizeKey(d)));

  /** Every school name in view the registry cannot place, deduped. */
  const unknown = new Map<string, "highschool" | "college">();
  for (const p of people) {
    for (const e of p.enriched?.educations ?? []) {
      const name = e.school?.trim();
      if (!name) continue;
      const guess = isHighSchool(e) ? "highschool" : "college";
      const key = normalizeKey(name);
      if (!key || declined.has(key) || unknown.has(key)) continue;

      /**
       * Asked under all three headings, and the accelerator one is the important one.
       *
       * LinkedIn's education section is where a batch gets listed — "Y Combinator /
       * S26", "buildspace / Nights & Weekends" — and those were the first two
       * "unknown schools" this found on a real roster. They are already in the
       * registry as accelerators, so asking a model about them would have been paying
       * to be told something the app knows, and then filing Y Combinator as a
       * university. `schoolStateLookup` asks accelerators first for the same reason.
       *
       * Both school facets are asked because the guess from a degree line is wrong on
       * any acronym.
       */
      const known = (["highschool", "college", "accelerator"] as const).some(
        (facet) => resolveTag(index, { label: name, facet }).kind === "exact"
      );
      if (known) continue;
      unknown.set(key, guess);
    }
  }
  if (unknown.size === 0) return 0;

  const take = [...unknown.entries()].slice(0, MAX_AUTO_SCHOOLS);
  const gate = await reserveTagging(owner, take.length);
  if (!gate.ok) {
    log.info("tag.autoschools.paused", { reason: gate.error, waiting: unknown.size });
    return 0;
  }

  const added: { label: string; facet: TagFacet; state?: string }[] = [];
  const refused: string[] = [];

  for (const [key, guess] of take) {
    /**
     * Stops asking and writes what it has.
     *
     * `paceGate` sleeps to stay inside the Groq free tier, so twelve questions can
     * take minutes when the window is busy — and the first version of this asked all
     * twelve and *then* wrote once, so a request that ran out of time threw away every
     * answer it had paid for. Same reason `tagFresh` and `adjudicateFresh` take one.
     */
    if (Date.now() > deadline) {
      log.info("tag.autoschools.deadline", { asked: added.length + refused.length, of: take.length });
      break;
    }
    const name = nameFor(people, key) ?? key;
    const answer = await suggestSchool(name);
    if (!answer.ok) {
      log.warn("tag.autoschools.asked", { error: answer.error });
      continue;
    }
    const { kind, state, sure } = answer.value;
    /**
     * Only "neither" is refused. An unsure answer still places the school.
     *
     * These are two different failures and conflating them threw away half the point.
     * "Warren High School" exists in a dozen states, so the model rightly declines to
     * name one — but it is still a school, and a school with no state is still a hub
     * the moment a second person shares it. Dismissing it would have made it invisible
     * on the graph forever to save a home state that was never available anyway.
     */
    if (kind === "neither") {
      refused.push(name);
      continue;
    }
    const placeState = sure ? state : null;

    /**
     * Asked again in the facet the model chose, because the guess from the degree line
     * is often the wrong one and a near-duplicate under the *right* heading is exactly
     * the case worth catching.
     */
    const res = resolveTag(index, { label: name, facet: kind });
    if (res.kind !== "new") {
      log.info("tag.autoschools.skipped", { why: res.kind, guess });
      continue;
    }
    added.push({ label: name, facet: kind, ...(placeState ? { state: placeState } : {}) });
  }

  if (added.length === 0 && refused.length === 0) return 0;

  // Re-read before writing: this ran a series of model calls, so the copy loaded at
  // the top is stale and writing it back would undo a teammate's edit.
  const now = await readTeam();
  let tags = now.taxonomy.tags;
  for (const a of added) {
    const def = makeTag({ label: a.label, facet: a.facet, weight: 0, promoted: false, state: a.state });
    if (!tags[def.id]) tags = { ...tags, [def.id]: def };
  }
  const dismissed = [...new Set([...now.taxonomy.dismissed, ...refused])];

  await set(TEAM_KEY, { ...now, taxonomy: { ...now.taxonomy, tags, dismissed } });
  log.info("tag.autoschools", {
    placed: added.length,
    withState: added.filter((a) => a.state).length,
    refused: refused.length,
    waiting: Math.max(0, unknown.size - take.length),
  });
  return added.length;
}

/** The school's name as written, recovered from the key it was deduped under. */
export function nameFor(people: Person[], key: string): string | null {
  for (const p of people) {
    for (const e of p.enriched?.educations ?? []) {
      if (e.school && normalizeKey(e.school) === key) return e.school.trim();
    }
  }
  return null;
}

/**
 * Teach the registry a spelling of a tag it already has.
 *
 * The review queue used to offer "Research Science Institute (RSI)" while RSI was
 * being awarded to the same six people, because deciding "unmatched" asked whether
 * the whole string was a key and the scorer asked whether any window inside it was.
 * `coverageOf` reconciles the two, and every term it calls `exact` is a name the
 * registry can read but has not written down.
 *
 * Writing it down is worth doing rather than merely hiding the row: an alias also
 * lets the tagger's own terms and the search chips resolve, which are two award paths
 * that only ever did exact lookups. And it is the safest write in the app — `addAlias`
 * cannot change a weight, cannot create an entry, and declines a key that is already
 * the id or already present, so running twice is running once.
 */
const MAX_AUTO_ALIAS = 24;

export async function autoAlias(people: Person[]): Promise<number> {
  const fresh = await readTeam();
  const exact = unmatchedTerms(people, fresh.taxonomy).filter((u) => u.covered?.exact);
  if (exact.length === 0) return 0;

  const take = aliasesToLearn(exact, fresh.taxonomy.tags, MAX_AUTO_ALIAS);
  if (take.length === 0) return 0;

  let tags = fresh.taxonomy.tags;
  for (const a of take) tags = addAlias(tags, a.id, a.label);
  // `addAlias` vets the key as well, so a row can survive the decision above and
  // still be declined. Nothing written means nothing to say.
  if (tags === fresh.taxonomy.tags) return 0;

  await set(TEAM_KEY, { ...fresh, taxonomy: { ...fresh.taxonomy, tags } });

  // Said out loud rather than truncated in silence: a capped sweep that reports the
  // full count reads as "covered everything" when it did not.
  log.info("tag.autoalias", {
    learned: take.length,
    dropped: exact.length - take.length,
  });
  return take.length;
}

/**
 * Everything the app may learn on its own, in the order it has to happen.
 *
 * One entry point because there are three doors into enrichment — the browser, a
 * campaign advance, and Claude over MCP — and until now only the browser learned
 * anything. A profile found by the overnight cron got no home state and no college
 * hub, which made the whole feature look like a one-off correction of the batch that
 * happened to be in the roster when it shipped.
 *
 * Both steps are score-neutral by construction, which is what makes them safe on an
 * unattended path: an alias cannot invent points and a school is written at zero
 * weight. `autoPromote` is deliberately *not* here — it mints scoring tags, and
 * `lib/campaignTag.ts` says in its own header that writing those is something the
 * agent is not allowed to do. That rule stands.
 *
 * Aliases first, because a spelling learned here can be the reason a school stops
 * looking unknown. Aliases read the batch, because a spelling only exists once the
 * tagger has just written it.
 *
 * ── Schools read the whole roster, and that is deliberate ─────────────────
 * Everything else here is gated by `taggedAt`, which makes an unfinished pass free to
 * abandon: whatever is left is picked up next time. Schools had no such door. Placing
 * one is paced by the Groq window and bounded by a deadline, so a tick that ran out of
 * time dropped the remaining names — and since the people they belonged to were now
 * stamped as tagged, nobody would ever look at them again. One quiet timeout and a
 * school is invisible on the graph permanently.
 *
 * Reading the roster instead of the batch makes the pass self-healing: a name missed
 * for any reason at all — a deadline, a rate limit, an enrichment that happened before
 * this existed — is simply still there next time. It is free when there is nothing to
 * do, which is the normal case: `autoSchools` resolves every name against the registry
 * and the dismissed list before it reserves anything, so a roster with no unplaced
 * school makes no model call and no write.
 */
export async function learnFrom(
  people: Person[],
  owner: ProfileId,
  deadline: number
): Promise<{ aliases: number; schools: number }> {
  const aliases = await autoAlias(people).catch((e) => {
    log.warn("learn.alias.failed", { error: e instanceof Error ? e.message : "unknown" });
    return 0;
  });
  if (Date.now() > deadline) return { aliases, schools: 0 };

  const everyone = await readRoster()
    .then((r) => Object.values(r).filter((p) => p.enriched))
    .catch(() => people);

  const schools = await autoSchools(everyone, owner, deadline).catch((e) => {
    log.warn("learn.schools.failed", { error: e instanceof Error ? e.message : "unknown" });
    return 0;
  });
  return { aliases, schools };
}
