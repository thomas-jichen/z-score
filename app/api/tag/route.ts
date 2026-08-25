import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import {
  extractMany,
  groqModel,
  hasGroq,
  suggestClassification,
  suggestSchool,
} from "@/lib/groq";
import type { Person } from "@/lib/people";
import { isHighSchool } from "@/lib/enrichment";
import type { ProfileId } from "@/lib/profiles";
import { migrateIfNeeded, readRoster, readTeam, writePeople } from "@/lib/serverState";
import { groundedTerms, unmatchedTerms, vocabulary } from "@/lib/tags";
import { autoSchools } from "@/lib/schools";
import { aliasesToLearn, withPromoted, worthPromoting } from "@/lib/team";
import { TEAM_KEY, type TeamState } from "@/lib/state";
import { set } from "@/lib/store";
import type { Archetype } from "@/lib/clusters";
import {
  addAlias,
  indexRegistry,
  makeTag,
  normalizeKey,
  resolveTag,
  type TagFacet,
} from "@/lib/tagRegistry";
import { reserveTagging } from "@/lib/ratelimit";
import { cleanSlugs, isBad, readJson, str } from "@/lib/validate";
import { adjudicateFresh } from "@/lib/tagAdjudicate";
import { log, timed } from "@/lib/log";

/**
 * The tagger.
 *
 * POST { slugs } runs term extraction over those people and writes the results
 * onto the roster. Called automatically once an enrichment run lands, and by
 * hand from the queue for search-only people, where a two-line snippet rarely
 * justifies a call.
 *
 * POST { classify } asks for a cluster and weight for one term, which happens
 * when a term is promoted on the taxonomy screen — once per term, not per
 * person. The answer is a suggestion that gets edited before it lands.
 *
 * Without a key this answers 200 with `skipped`, not an error. Losing new-term
 * discovery must not look like a broken screen.
 */

export const maxDuration = 300;

const MAX_PER_CALL = 60;

type Body = { slugs?: unknown; classify?: unknown; force?: unknown };

export async function POST(req: Request) {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  const body = await readJson<Body>(req);
  if (isBad(body)) return NextResponse.json({ ok: false, error: body.error }, { status: body.status });

  if (!hasGroq()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason:
        "No Groq API key is set, so new terms are not being discovered. Add ZSCORE_GROQ_API_KEY to enable it.",
    });
  }

  // One term to classify, for the promote flow.
  const term = str(body.classify, 80).trim();
  if (term) {
    const gate = await reserveTagging(r.profile, 1);
    if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });

    const result = await suggestClassification(term);
    if (!result.ok) {
      log.warn("tag.classify.failed", { model: groqModel() });
      return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
    }
    log.info("tag.classify", { model: groqModel(), cluster: result.value.cluster ?? "none" });
    return NextResponse.json({ ok: true, classification: result.value });
  }

  const slugs = cleanSlugs(body.slugs, MAX_PER_CALL);
  if (isBad(slugs)) return NextResponse.json({ ok: false, error: slugs.error }, { status: slugs.status });

  try {
    await migrateIfNeeded();
    const [roster, team] = await Promise.all([readRoster(), readTeam()]);

    // Skip anyone already tagged unless asked again explicitly, so a repeated
    // enrichment does not pay to re-read the same profile.
    const force = body.force === true;
    const targets = slugs
      .map((s) => roster[s])
      .filter((p): p is Person => Boolean(p) && (force || !p.taggedAt));

    if (targets.length === 0) {
      return NextResponse.json({ ok: true, tagged: 0, terms: 0, note: "Nothing new to tag." });
    }

    const gate = await reserveTagging(r.profile, targets.length);
    if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });

    const known = vocabulary(team.taxonomy);
    const { results, errors } = await timed(
      "tag.extract",
      { model: groqModel(), count: targets.length },
      () => extractMany(targets, known)
    );

    const at = new Date().toISOString();
    const byslug = new Map(results.map((x) => [x.slug, x]));
    const refused: string[] = [];
    const updated: Person[] = targets.map((p) => {
      const found = byslug.get(p.slug);

      /**
       * The model's terms get the gates the scanner applies.
       *
       * Otherwise the tagger is a way around every rule in `proseTags`. Reading
       * "YCombinator Summer Fellow Grant", it returned two terms: the fellowship,
       * which is now a tag of its own, and the bare "Y Combinator", which resolved
       * exactly and paid 2.0 for a grant that is not a cheque. The scanner refuses
       * that phrase and always has; this path never asked.
       */
      const { kept, dropped } = groundedTerms(found?.terms ?? [], team.taxonomy);
      for (const d of dropped) refused.push(`${d.label} (${d.why})`);

      return {
        ...p,
        /**
         * Merged, then minus whatever the gate refused.
         *
         * Merging alone meant a bad term could never leave: a union only grows, so a
         * stray "Y Combinator" would outlive every future re-tag. Replacing outright
         * was the first attempt and it was worse — the model is not deterministic, and
         * one forced run on James Liu silently dropped Paradigm Fellowship and
         * GreylockX, both of which are genuinely in his honours. Merging is right for
         * exactly the reason the old comment gave.
         *
         * So the union is kept and the refusals are subtracted from it. A term the
         * model re-offered and the rules rejected goes, whether it arrived this run or
         * six runs ago, and nothing that was only *missed* is touched.
         */
        extractedTerms: mergeTerms(p.extractedTerms, kept, dropped),
        // Stamped even on a miss, or an unproductive profile is retried forever.
        taggedAt: at,
        updatedAt: at,
      };
    });

    // Said out loud, because a credential dropped in silence is indistinguishable
    // from one the model never found.
    if (refused.length > 0) {
      log.info("tag.refused", { count: refused.length, terms: refused.join(", ") });
    }

    await writePeople(updated);

    /**
     * Add what the model is sure about, and only that.
     *
     * Without this, every finding waits for someone to click promote — so a batch of
     * twenty people lands with Palantir, a YC company and two venture funds all
     * sitting in a queue, scoring nothing, and the roster ranks as though none of it
     * were there. The classifier is given the taxonomy's own anchors and has to say it
     * recognised the thing; anything it is guessing at stays in the queue, which is
     * what the queue is for.
     */
    /**
     * First, write down the spellings the registry can already read.
     *
     * Before auto-promotion, because an alias learned here can be the reason a term
     * in the same batch stops looking new. Free and unmetered — no model call, and an
     * alias cannot invent a score, it can only make a match the scorer was already
     * making an exact one.
     */
    const learned = await autoAlias(updated).catch((e) => {
      log.warn("tag.autoalias.failed", { error: e instanceof Error ? e.message : "unknown" });
      return 0;
    });

    /**
     * Then place the schools nobody had seeded.
     *
     * A home state is only knowable through `TagDef.state`, which until now existed
     * only on the fifty-odd schools seeded by hand — so eighteen people in this roster
     * named a high school and were still from nowhere. Same shape of gap on the other
     * side: a college the registry has never heard of resolves to no tag, so it can
     * never be a hub on the graph however many people share it.
     */
    const placed = await autoSchools(updated, r.profile, Date.now() + 60_000).catch((e) => {
      log.warn("tag.autoschools.failed", { error: e instanceof Error ? e.message : "unknown" });
      return 0;
    });

    // Re-read if either earlier step wrote the taxonomy, since a learned alias or a
    // newly placed school can be the reason a term stops looking new.
    const before = learned > 0 || placed > 0 ? await readTeam() : team;
    const promoted = await autoPromote(updated, before).catch((e) => {
      // Best effort, always. The people are already written; a rate limit or a bad
      // response here must not turn a successful tagging run into a 500 and have the
      // client report that nothing happened.
      log.warn("tag.autopromote.failed", { error: e instanceof Error ? e.message : "unknown" });
      return [] as string[];
    });

    /**
     * Then judge the prose matches the rules could not settle.
     *
     * After the terms are written, because a new term can resolve to a tag and so
     * change which matches are still unvouched. Best effort for the same reason
     * auto-promotion is: the people are already saved, and a rate limit here must not
     * turn a successful tagging run into a 500.
     */
    const judged = await adjudicateFresh(
      r.profile,
      updated.map((p) => p.slug),
      Date.now() + 60_000
    ).catch((e) => {
      log.warn("tag.adjudicate.failed", { error: e instanceof Error ? e.message : "unknown" });
      return { judged: 0, approved: 0 };
    });

    const termCount = results.reduce((n, x) => n + x.terms.length, 0);
    return NextResponse.json({
      ok: true,
      tagged: updated.length,
      terms: termCount,
      adjudicated: judged.judged,
      approved: judged.approved,
      promoted,
      /** Schools the registry did not know, now placed. Zero weight, so no score moved. */
      schoolsPlaced: placed,
      people: updated,
      // Partial failure is reported rather than swallowed: some people did get
      // tagged, and the caller should be able to say so.
      errors: errors.slice(0, 3),
    });
  } catch (e) {
    log.error("tag.failed", { error: e instanceof Error ? e.message : "unknown" });
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Tagging failed." },
      { status: 500 }
    );
  }
}

/** So the UI can tell you the tagger is off before you go looking for terms. */
export async function GET() {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, enabled: hasGroq(), model: hasGroq() ? groqModel() : null });
}

/**
 * Classify every unresolved finding across a batch and add the confident ones.
 *
 * One call per label, once ever: a promoted tag resolves next time, and one left in
 * the queue is remembered as unmatched rather than re-asked. Capped, because a first
 * enrichment of a large batch can surface a lot at once and the point is to clear the
 * obvious names, not to spend a rate limit on a long tail nobody will read.
 */
const MAX_AUTO_PROMOTE = 8;

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

/**
 * The stored terms, plus what this run found, minus what it refused.
 *
 * Compared through `normalizeKey` so a refusal lands on the spelling that is stored
 * rather than only on the one the model happened to return this time.
 */
function mergeTerms(
  stored: string[] | undefined,
  kept: string[],
  dropped: { label: string }[]
): string[] {
  const refused = new Set(dropped.map((d) => normalizeKey(d.label)));
  return [...new Set([...(stored ?? []), ...kept])].filter((l) => !refused.has(normalizeKey(l)));
}

async function autoAlias(people: Person[]): Promise<number> {
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

async function autoPromote(people: Person[], team: TeamState): Promise<string[]> {
  const pending = unmatchedTerms(people, team.taxonomy)
    .filter((u) => u.facet && PROMOTABLE.has(u.facet))
    /**
     * Covered terms are dropped here rather than at the write.
     *
     * `withPromoted` refuses them, which is the guarantee that matters, but it
     * refuses them *after* this loop has paid for a classification each. "SSP
     * International" is a permanent resident of the queue — the registry can read it,
     * so it will never be promoted, and it was burning a model call and one of only
     * eight slots on every single tagging run.
     */
    .filter((u) => !u.covered)
    .slice(0, MAX_AUTO_PROMOTE);
  if (pending.length === 0) return [];

  const additions: { label: string; facet: TagFacet; weight: number; cluster: Archetype | null }[] =
    [];
  for (const u of pending) {
    const res = await suggestClassification(u.term);
    if (!res.ok || !worthPromoting(res.value)) continue;
    additions.push({
      label: u.term,
      // The extractor's facet wins where it has one: it read a structured field, and
      // the model is working from the words alone.
      facet: u.facet ?? res.value.facet!,
      weight: res.value.weight,
      cluster: res.value.cluster,
    });
  }
  if (additions.length === 0) return [];

  /**
   * Re-read before writing.
   *
   * The taxonomy is one shared document and this runs after a slow batch of model
   * calls, so the copy loaded at the top of the request is stale by now — writing it
   * back would silently undo anything a teammate changed in between.
   */
  const fresh = await readTeam();
  const tags = withPromoted(fresh.taxonomy.tags, additions);
  if (tags === fresh.taxonomy.tags) return [];
  await set(TEAM_KEY, { ...fresh, taxonomy: { ...fresh.taxonomy, tags } });

  /**
   * What actually landed, read off the registry rather than off the request.
   *
   * This used to return `additions.map(a => a.label)`, but `withPromoted` has vetoes
   * of its own — a banned name, a near duplicate, a term the registry can already
   * read — so the caller was told a term had been promoted when it had just been
   * declined. Diffing the ids is the only answer that cannot drift from the write.
   */
  const before = new Set(Object.keys(fresh.taxonomy.tags));
  const labels = Object.keys(tags)
    .filter((id) => !before.has(id))
    .map((id) => tags[id].label);
  log.info("tag.autopromote", { count: labels.length, asked: additions.length });
  return labels;
}

/** Facets a machine may add unattended. The rest are facts, or need a human. */
const PROMOTABLE = new Set<TagFacet>([
  "program",
  "accelerator",
  "startup",
  "lab",
  "club",
  "company",
]);
