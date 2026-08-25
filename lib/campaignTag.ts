import { extractMany, hasGroq } from "./groq";
import type { Person } from "./people";
import { reserveTagging } from "./ratelimit";
import { learnFrom } from "./schools";
import { readRoster, readTeam, writePeople } from "./serverState";
import { groundedTerms, vocabulary } from "./tags";
import { log } from "./log";

/**
 * Tag the people an enrichment run just landed.
 *
 * ── Why this is bounded and allowed to give up ────────────────────────────
 * Groq's free tier moves about three to six profiles a minute — the ledger in
 * lib/groq.ts paces every call against 8,000 tokens a minute — so ten people is
 * two to three minutes of a tick's four. Trying to finish is the wrong goal.
 *
 * `taggedAt` is what makes giving up cheap: /api/tag skips anyone already tagged,
 * so whatever this leaves behind is picked up by the next advance at no cost.
 * The campaign's value is in the searching and the queueing; tagging is the part
 * that can safely lag.
 *
 * Deliberately not calling /api/tag over HTTP. That route would re-read the
 * roster, re-check the rate limit and re-run auto-promotion — and auto-promotion
 * writes to the shared taxonomy, which the agent is explicitly not allowed to do.
 *
 * That rule is about *scoring* tags, and keeping it does not mean learning nothing.
 * `learnFrom` is score-neutral by construction — an alias cannot invent points and a
 * school is written at zero weight — so it runs here too. Without it a profile found
 * by the overnight cron got no home state and no college hub, which made the whole
 * correction look like a one-off tidy of whatever happened to be in the roster.
 */

export type TagResult = { tagged: number; note?: string };

/** Small enough that one chunk fits in a tick with room for the rest of the work. */
const CHUNK = 10;

export async function tagFresh(
  owner: Parameters<typeof reserveTagging>[0],
  slugs: string[],
  deadline: number,
  /**
   * Read a profile again even though it has been read before.
   *
   * The campaign never wants this — `taggedAt` is what makes an unfinished chunk free
   * to abandon. The MCP door does: it only calls here having just paid for fresh
   * profile text, and the text is the input, so a stale `taggedAt` would mean paying
   * for a new snapshot and then scoring the old one.
   */
  force = false
): Promise<TagResult> {
  if (slugs.length === 0) return { tagged: 0 };

  if (!hasGroq()) {
    // Not a failure. The score comes from structured fields and confirmed search
    // terms either way; what is lost is new-term discovery, not the product.
    return { tagged: 0, note: "The tagger is off, so no new terms were read." };
  }

  const [roster, team] = await Promise.all([readRoster(), readTeam()]);
  const targets = slugs
    .map((s) => roster[s])
    .filter((p): p is Person => Boolean(p) && (force || !p.taggedAt))
    .slice(0, CHUNK);

  if (targets.length === 0) return { tagged: 0 };

  const gate = await reserveTagging(owner, targets.length);
  if (!gate.ok) return { tagged: 0, note: `Tagging paused: ${gate.error}` };

  const known = vocabulary(team.taxonomy);
  const { results, errors } = await extractMany(targets, known);

  const at = new Date().toISOString();
  const byslug = new Map(results.map((x) => [x.slug, x]));
  const refused: string[] = [];
  const updated: Person[] = targets.map((p) => {
    const found = byslug.get(p.slug);

    /**
     * The same gate the route applies, for the same reason.
     *
     * Without it this path is a way around every rule in `proseTags`: the model reads
     * "YCombinator Summer Fellow Grant" and can return the bare accelerator name,
     * which resolves exactly and pays 2.0 for a grant that is not a cheque. Leaving it
     * out here meant the fix held for anyone a human tagged and not for anyone a
     * campaign found, which is the larger half of the roster over time.
     */
    const { kept, dropped } = groundedTerms(found?.terms ?? [], team.taxonomy);
    for (const d of dropped) refused.push(`${d.label} (${d.why})`);

    return {
      ...p,
      // Merged, never replaced: a term found last time and missed this time is
      // not evidence it was wrong.
      extractedTerms: [...new Set([...(p.extractedTerms ?? []), ...kept])],
      // Stamped even on a miss, or an unproductive profile is retried forever.
      taggedAt: at,
      updatedAt: at,
    };
  });

  await writePeople(updated);
  if (refused.length > 0) {
    log.info("campaign.tag.refused", { count: refused.length, terms: refused.join(", ") });
  }
  log.info("campaign.tagged", { count: updated.length, errors: errors.length });

  // Score-neutral, so it is allowed here. See the header.
  const learned = await learnFrom(updated, owner, deadline).catch(() => ({ aliases: 0, schools: 0 }));

  const left = slugs.length - targets.length;
  const notes: string[] = [];
  if (errors.length > 0) notes.push(`${errors.length} could not be read.`);
  if (left > 0) notes.push(`${left} will be tagged on the next pass.`);
  if (Date.now() > deadline) notes.push("Tagging stopped at the time limit.");
  if (learned.schools > 0) {
    notes.push(`Placed ${learned.schools} ${learned.schools === 1 ? "school" : "schools"} the registry did not know.`);
  }

  return { tagged: updated.length, note: notes.length ? notes.join(" ") : undefined };
}
