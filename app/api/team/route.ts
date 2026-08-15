import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import {
  TEAM_KEY,
  hydrateTeam,
  mergeTeam,
  type TeamState,
} from "@/lib/state";
import { cleanTaxonomy, cleanTerms } from "@/lib/team";
import { migrateIfNeeded, readTeam } from "@/lib/serverState";
import { get, set } from "@/lib/store";
import { isBad, readJson } from "@/lib/validate";
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
