import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import { runShards, activeProvider, isFreeTier, FREE_TIER_CAP } from "@/lib/search";
import { COST_PER_QUERY } from "@/lib/query";
import { reserveSearch } from "@/lib/ratelimit";
import type { Shard } from "@/lib/types";
import { bounded, isBad, readJson, str } from "@/lib/validate";
import { log } from "@/lib/log";

export const maxDuration = 300;

/** Cap per request so one call cannot run an unbounded sweep. */
const MAX_SHARDS_PER_CALL = 25;

export async function POST(req: Request) {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  const body = await readJson<{ shards?: unknown; num?: unknown }>(req);
  if (isBad(body)) return NextResponse.json({ ok: false, error: body.error }, { status: body.status });

  const raw = Array.isArray(body.shards) ? body.shards : [];
  if (raw.length === 0) {
    return NextResponse.json({ ok: false, error: "No shards supplied." }, { status: 400 });
  }
  if (raw.length > MAX_SHARDS_PER_CALL) {
    return NextResponse.json(
      { ok: false, error: `Send at most ${MAX_SHARDS_PER_CALL} shards per request.` },
      { status: 400 }
    );
  }

  const shards: Shard[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const query = str(o.query, 1000).trim();
    if (!query) continue;
    shards.push({ id: str(o.id, 40) || `s${shards.length}`, query });
  }
  if (shards.length === 0) {
    return NextResponse.json({ ok: false, error: "No usable query." }, { status: 400 });
  }

  // Serper bills per query. A human cannot out-click this limit; a loop can.
  const gate = await reserveSearch(r.profile);
  if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });

  const num = bounded(body.num, 10, 100) ?? 100;
  const results = await runShards(shards, 5, num);

  log.info("sweep.ran", {
    shards: shards.length,
    hits: results.reduce((n, x) => n + x.count, 0),
    provider: activeProvider(),
    usd: Number((shards.length * COST_PER_QUERY).toFixed(4)),
  });

  return NextResponse.json({
    ok: true,
    provider: activeProvider(),
    resultsPerQuery: isFreeTier() ? FREE_TIER_CAP : 100,
    freeTier: isFreeTier(),
    results,
  });
}
