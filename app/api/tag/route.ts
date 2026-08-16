import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import { extractMany, hasGroq, groqModel, suggestClassification } from "@/lib/groq";
import type { Person } from "@/lib/people";
import { migrateIfNeeded, readRoster, readTeam, writePeople } from "@/lib/serverState";
import { unmatchedTerms, vocabulary } from "@/lib/tags";
import { withPromoted, worthPromoting } from "@/lib/team";
import { TEAM_KEY, type TeamState } from "@/lib/state";
import { set } from "@/lib/store";
import type { Archetype } from "@/lib/clusters";
import type { TagFacet } from "@/lib/tagRegistry";
import { reserveTagging } from "@/lib/ratelimit";
import { cleanSlugs, isBad, readJson, str } from "@/lib/validate";
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
    const updated: Person[] = targets.map((p) => {
      const found = byslug.get(p.slug);
      const terms = found?.terms.map((t) => t.label) ?? [];
      return {
        ...p,
        // Merge rather than replace: a term the model found last time and missed
        // this time is not evidence it was wrong.
        extractedTerms: [...new Set([...(p.extractedTerms ?? []), ...terms])],
        // Stamped even on a miss, or an unproductive profile is retried forever.
        taggedAt: at,
        updatedAt: at,
      };
    });

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
    const promoted = await autoPromote(updated, team).catch((e) => {
      // Best effort, always. The people are already written; a rate limit or a bad
      // response here must not turn a successful tagging run into a 500 and have the
      // client report that nothing happened.
      log.warn("tag.autopromote.failed", { error: e instanceof Error ? e.message : "unknown" });
      return [] as string[];
    });

    const termCount = results.reduce((n, x) => n + x.terms.length, 0);
    return NextResponse.json({
      ok: true,
      tagged: updated.length,
      terms: termCount,
      promoted,
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

async function autoPromote(people: Person[], team: TeamState): Promise<string[]> {
  const pending = unmatchedTerms(people, team.taxonomy)
    .filter((u) => u.facet && PROMOTABLE.has(u.facet))
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

  const labels = additions.map((a) => a.label);
  log.info("tag.autopromote", { count: labels.length });
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
