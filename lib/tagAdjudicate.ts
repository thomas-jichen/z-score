import { adjudicateMatches, hasGroq } from "./groq";
import type { Person } from "./people";
import type { ProfileId } from "./profiles";
import { reserveTagging } from "./ratelimit";
import { readRoster, readTeam, writePeople } from "./serverState";
import { unvouchedTags } from "./tags";
import { log } from "./log";

/**
 * Ask the model about the prose matches the rules could not settle.
 *
 * `MATCH_POLICY` marks the names that are also ordinary English words, and
 * `hasQualifier` reads the clause around one looking for something that means
 * "holds this". Where that finds nothing the answer is genuinely unknown, and this
 * is the only step in the pipeline allowed to guess. Grace Kasten's headline is
 * "Z Fellows" because that is where she works; Sand Rao's is "Building something
 * new | Z Fellows" because he went through it, and no rule over the words separates
 * them.
 *
 * ── Every limit that applies to tagging applies here ──────────────────────
 * This is a second paid LLM step, so it is bounded the same three ways the first
 * one is, and one more besides:
 *
 *   1. Groq's own limits, by construction. `adjudicateMatches` goes through
 *      `chatJson` → `chat` → `reserve`, which is the sliding rpm/tpm ledger and the
 *      daily counters in lib/groq.ts. There is no path here that reaches `fetch`
 *      without passing that gate, which is the whole reason the prompt lives in
 *      groq.ts beside its siblings rather than in this file.
 *   2. The app's own hourly cap, through `reserveTagging`, charged one unit per
 *      person — which is also one call per person, so the unit means something.
 *   3. A ceiling on how much one invocation may do at all: CHUNK people, and at
 *      most MAX_UNVOUCHED candidates each, in a single call per person.
 *   4. The verdict is cached on the person, including a `false`. An absent key
 *      means "not yet asked", so keeping the rejections is what stops every
 *      tagging pass re-paying for the same no.
 *
 * Like tagging, it is allowed to give up. Whatever it does not reach this time has
 * no verdict, so the next pass picks it up, and a campaign's value is in the
 * searching either way.
 */

export type AdjudicateResult = { judged: number; approved: number; note?: string };

/**
 * People per invocation.
 *
 * One call each, and a call is what the rate limiter counts. Four rather than the
 * tagger's ten because these calls carry more context per candidate and a tick has
 * already spent most of its budget on the tagger by the time it gets here.
 */
const CHUNK = 4;

export async function adjudicateFresh(
  owner: ProfileId,
  slugs: string[],
  deadline: number
): Promise<AdjudicateResult> {
  if (slugs.length === 0) return { judged: 0, approved: 0 };

  if (!hasGroq()) {
    // Not a failure. Without a verdict an unvouched match simply does not score,
    // which is the conservative answer and the one the rules already gave.
    return { judged: 0, approved: 0, note: "The tagger is off, so nothing was adjudicated." };
  }

  const [roster, team] = await Promise.all([readRoster(), readTeam()]);

  const work: { person: Person; items: ReturnType<typeof unvouchedTags> }[] = [];
  for (const slug of slugs) {
    const person = roster[slug];
    if (!person) continue;
    const items = unvouchedTags(person, team.taxonomy);
    if (items.length > 0) work.push({ person, items });
    if (work.length >= CHUNK) break;
  }

  if (work.length === 0) return { judged: 0, approved: 0 };

  const gate = await reserveTagging(owner, work.length);
  if (!gate.ok) return { judged: 0, approved: 0, note: `Adjudication paused: ${gate.error}` };

  const updated: Person[] = [];
  let judged = 0;
  let approved = 0;
  const at = new Date().toISOString();

  for (const { person, items } of work) {
    // Checked before each call rather than after, so a tick that is nearly out of
    // time does not start a call it cannot use the answer from.
    if (Date.now() > deadline) break;

    const r = await adjudicateMatches(items);
    if (!r.ok) {
      log.warn("groq.adjudicate.failed", { slug: person.slug, error: r.error });
      continue;
    }

    judged += Object.keys(r.value).length;
    approved += Object.values(r.value).filter(Boolean).length;
    updated.push({
      ...person,
      adjudicated: { ...(person.adjudicated ?? {}), ...r.value },
      updatedAt: at,
    });
  }

  if (updated.length > 0) await writePeople(updated);

  log.info("groq.adjudicate", { owner, people: updated.length, judged, approved });
  return { judged, approved };
}
