import { suggestSchool } from "./groq";
import { log } from "./log";
import type { Person } from "./people";
import type { ProfileId } from "./profiles";
import { reserveTagging } from "./ratelimit";
import { readTeam } from "./serverState";
import { TEAM_KEY } from "./state";
import { set } from "./store";
import { indexRegistry, makeTag, normalizeKey, resolveTag, type TagFacet } from "./tagRegistry";
import { isHighSchool } from "./enrichment";

/**
 * Placing the schools nobody seeded.
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
