import type { Hit, Shard, ShardResult } from "./types";

/**
 * Two providers. Serper is the default and the one to build on: it bills per
 * query (~$0.001) and returns up to 100 results per call.
 *
 * Google Custom Search is supported so an existing grandfathered key keeps
 * working, but Google discontinues the JSON API on 2027-01-01 and no longer
 * issues new keys, so treat it as a migration bridge rather than a target.
 */
export type Provider = "serper" | "google_cse";

export function activeProvider(): Provider {
  if (process.env.ZSCORE_SERPER_API_KEY) return "serper";
  if (process.env.ZSCORE_GOOGLE_CSE_KEY && process.env.ZSCORE_GOOGLE_CSE_CX) return "google_cse";
  return "serper"; // will surface a clear error downstream
}

const PROFILE_RE = /linkedin\.com\/in\/([^/?#\s]+)/i;

/** Pull the stable profile slug. This is the dedupe key — never dedupe on name. */
export function extractSlug(url: string): string | null {
  const m = url.match(PROFILE_RE);
  if (!m) return null;
  return decodeURIComponent(m[1]).toLowerCase().replace(/\/$/, "");
}

/**
 * LinkedIn SERP titles look like "Jane Doe - Founder, Acme - Acme | LinkedIn".
 * Strip the site suffix first, then split — otherwise "| LinkedIn" ends up
 * glued to the headline, which is the bug in the original n8n workflow.
 */
export function parseTitle(rawTitle: string): { name: string; headline: string } {
  const cleaned = rawTitle
    .replace(/\s*[|\-–]\s*LinkedIn\s*$/i, "")
    .replace(/\s*\|\s*$/, "")
    .trim();

  const parts = cleaned.split(" - ");
  if (parts.length === 1) return { name: cleaned, headline: "" };
  return {
    name: parts[0].trim(),
    headline: parts.slice(1).join(" - ").trim(),
  };
}

/**
 * Look for a stated class year, most explicit form first. Kept conservative:
 * only years in a plausible band, so stray numbers and birth years don't match.
 * Two-digit apostrophe years ("TJHSST '28") are common on student profiles.
 */
export function inferYear(text: string): string | undefined {
  const qualified = text.match(
    /(?:class of|c\/o|expected|graduating)\s*['’‘ʼ]?(20[2-3]\d)\b/i
  );
  if (qualified) return qualified[1];

  // LinkedIn writes a curly apostrophe (U+2019), not the ASCII one: real
  // headlines are "Stanford ’30", so matching only ' meant this branch never
  // fired on live data and the class column stayed empty.
  const apostrophe = text.match(/['’‘ʼ](\d{2})\b/);
  if (apostrophe) {
    const yy = Number(apostrophe[1]);
    if (yy >= 24 && yy <= 35) return `20${apostrophe[1]}`;
  }

  const bare = text.match(/\b(20[2-3]\d)\b/);
  return bare ? bare[1] : undefined;
}

function toHit(shardId: string, title: string, link: string, snippet: string): Hit | null {
  const slug = extractSlug(link);
  if (!slug) return null;
  const { name, headline } = parseTitle(title || "");
  return {
    slug,
    name,
    headline,
    url: `https://www.linkedin.com/in/${slug}`,
    snippet: snippet || "",
    matchedShards: [shardId],
    inferredYear: inferYear(`${headline} ${snippet}`),
  };
}

/** Serper's free tier rejects num > 10 outright. Latched once, then respected. */
export const FREE_TIER_CAP = 10;
let freeTierDetected = false;

export function isFreeTier(): boolean {
  return freeTierDetected;
}

function isFreeTierRejection(status: number, body: string): boolean {
  return status === 400 && /not allowed for free accounts/i.test(body);
}

async function callSerper(key: string, query: string, num: number) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num }),
  });
  return { res, body: await res.text() };
}

async function runSerper(shard: Shard, num: number): Promise<ShardResult> {
  const key = process.env.ZSCORE_SERPER_API_KEY;
  if (!key) return { shardId: shard.id, count: 0, hits: [], error: "ZSCORE_SERPER_API_KEY is not set" };

  const wanted = freeTierDetected ? FREE_TIER_CAP : Math.min(num, 100);
  let { res, body } = await callSerper(key, shard.query, wanted);

  // Free accounts are capped at 10 results per query. Detect once, latch it,
  // and retry — so the sweep completes instead of failing every shard, and
  // automatically uses the full 100 if the account is later upgraded.
  if (isFreeTierRejection(res.status, body) && wanted > FREE_TIER_CAP) {
    freeTierDetected = true;
    ({ res, body } = await callSerper(key, shard.query, FREE_TIER_CAP));
  }

  if (!res.ok) {
    return {
      shardId: shard.id,
      count: 0,
      hits: [],
      error: `Serper ${res.status}: ${body.slice(0, 200)}`,
    };
  }

  let data: { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
  try {
    data = JSON.parse(body);
  } catch {
    return { shardId: shard.id, count: 0, hits: [], error: "Serper returned unparseable JSON" };
  }

  const hits = (data.organic ?? [])
    .map((o) => toHit(shard.id, o.title ?? "", o.link ?? "", o.snippet ?? ""))
    .filter((h): h is Hit => h !== null);

  return { shardId: shard.id, count: hits.length, hits };
}

async function runGoogleCse(shard: Shard, num: number): Promise<ShardResult> {
  const key = process.env.ZSCORE_GOOGLE_CSE_KEY;
  const cx = process.env.ZSCORE_GOOGLE_CSE_CX;
  if (!key || !cx) {
    return { shardId: shard.id, count: 0, hits: [], error: "ZSCORE_GOOGLE_CSE_KEY / ZSCORE_GOOGLE_CSE_CX not set" };
  }

  // CSE returns 10 per call and caps at 100 total (start maxes at 91).
  const pages = Math.min(Math.ceil(num / 10), 10);
  const hits: Hit[] = [];

  for (let p = 0; p < pages; p++) {
    const start = p * 10 + 1;
    if (start > 91) break;

    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", key);
    url.searchParams.set("cx", cx);
    url.searchParams.set("q", shard.query);
    url.searchParams.set("start", String(start));

    const res = await fetch(url);
    if (!res.ok) {
      return {
        shardId: shard.id,
        count: hits.length,
        hits,
        error: `Google CSE ${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as {
      items?: Array<{ title?: string; link?: string; snippet?: string }>;
      queries?: { nextPage?: unknown[] };
    };

    const items = data.items ?? [];
    for (const it of items) {
      const h = toHit(shard.id, it.title ?? "", it.link ?? "", it.snippet ?? "");
      if (h) hits.push(h);
    }

    // Terminate on a short page or an absent nextPage. The original workflow
    // defaulted the cursor back to 1 here, which looped forever.
    if (items.length < 10 || !data.queries?.nextPage?.length) break;
  }

  return { shardId: shard.id, count: hits.length, hits };
}

export async function runShard(shard: Shard, num = 100): Promise<ShardResult> {
  try {
    return activeProvider() === "serper" ? await runSerper(shard, num) : await runGoogleCse(shard, num);
  } catch (e) {
    return {
      shardId: shard.id,
      count: 0,
      hits: [],
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

/** Bounded-concurrency map so a wide batch doesn't open 50 sockets at once. */
export async function runShards(shards: Shard[], concurrency = 5, num = 100): Promise<ShardResult[]> {
  const out: ShardResult[] = new Array(shards.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= shards.length) return;
      out[i] = await runShard(shards[i], num);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, shards.length) }, worker));
  return out;
}
