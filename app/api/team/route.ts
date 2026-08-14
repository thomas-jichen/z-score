import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import { isArchetype, type Archetype } from "@/lib/clusters";
import {
  TEAM_KEY,
  hydrateTeam,
  mergeTeam,
  type CustomTerms,
  type TaxonomyPrefs,
  type TeamState,
} from "@/lib/state";
import { migrateIfNeeded, readTeam } from "@/lib/serverState";
import { get, set } from "@/lib/store";
import { isBad, readJson, strList } from "@/lib/validate";
import { log } from "@/lib/log";

/**
 * The team's shared tuning: taxonomy weights, cluster assignments, the promote
 * and dismiss lists, and the custom search menu options.
 *
 * Shared rather than per-teammate because a split scoring model would give one
 * person three different z-scores depending on who was looking, which defeats
 * the point of a shared ranked list.
 *
 * Both halves sit in one small document. They have different writers — the sweep
 * screen adds custom terms, the taxonomy screen changes weights — so a write is
 * read-modify-write with a field-level merge. At three users and a few KB the
 * race is not worth a second key.
 */

const MAX_TERMS = 500;
const MAX_MENU_ITEMS = 200;
const TERM_LEN = 80;

export async function GET() {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  try {
    await migrateIfNeeded();
    return NextResponse.json({ ok: true, team: await readTeam() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Store read failed." },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  const body = await readJson<Partial<TeamState>>(req);
  if (isBad(body)) return NextResponse.json({ ok: false, error: body.error }, { status: body.status });

  const patch: Partial<TeamState> = {};
  if (body.taxonomy) patch.taxonomy = cleanTaxonomy(body.taxonomy);
  if (body.customTerms) patch.customTerms = cleanTerms(body.customTerms);

  if (!patch.taxonomy && !patch.customTerms) {
    return NextResponse.json({ ok: false, error: "Nothing to change." }, { status: 400 });
  }

  try {
    await migrateIfNeeded();
    const current = hydrateTeam(await get<Partial<TeamState>>(TEAM_KEY));
    const next = mergeTeam(current, patch);
    await set(TEAM_KEY, next);

    if (patch.taxonomy) {
      log.info("team.taxonomy", {
        weights: Object.keys(next.taxonomy.weights).length,
        promoted: next.taxonomy.promoted.length,
        dismissed: next.taxonomy.dismissed.length,
      });
    }
    return NextResponse.json({ ok: true, team: next });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Store write failed." },
      { status: 500 }
    );
  }
}

/* ── Validation ─────────────────────────────────────────────────────────── */

/**
 * Weights are clamped rather than rejected, and clusters are checked against the
 * real cluster ids so a stale client cannot write "polymath" back into the
 * table — it stopped being a cluster and became a badge.
 */
function cleanTaxonomy(raw: Partial<TaxonomyPrefs>): TaxonomyPrefs {
  const weights: Record<string, number> = {};
  for (const [term, value] of Object.entries(raw.weights ?? {}).slice(0, MAX_TERMS)) {
    const n = Number(value);
    if (!term || term.length > TERM_LEN || !Number.isFinite(n)) continue;
    weights[term] = Math.min(Math.max(Math.round(n * 10) / 10, 0), 2);
  }

  const clusters: Record<string, Archetype | null> = {};
  for (const [term, value] of Object.entries(raw.clusters ?? {}).slice(0, MAX_TERMS)) {
    if (!term || term.length > TERM_LEN) continue;
    clusters[term] = isArchetype(value) ? value : null;
  }

  return {
    weights,
    clusters,
    promoted: strList(raw.promoted, MAX_TERMS, TERM_LEN),
    dismissed: strList(raw.dismissed, MAX_TERMS * 2, TERM_LEN),
  };
}

function cleanTerms(raw: Partial<CustomTerms>): CustomTerms {
  return {
    programs: strList(raw.programs, MAX_MENU_ITEMS, TERM_LEN),
    titles: strList(raw.titles, MAX_MENU_ITEMS, TERM_LEN),
    colleges: strList(raw.colleges, MAX_MENU_ITEMS, TERM_LEN),
    highSchools: strList(raw.highSchools, MAX_MENU_ITEMS, TERM_LEN),
    years: strList(raw.years, 40, 8),
  };
}
