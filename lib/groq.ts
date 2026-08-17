import type { Archetype } from "./clusters";
import { ARCHETYPES, isArchetype } from "./clusters";
import type { Person } from "./people";
import { log } from "./log";
import { envNumber } from "./ratelimit";
import { isTagFacet, type TagFacet } from "./tagRegistry";

/**
 * Groq client for the one job the model is trusted with: reading credential
 * names out of free text.
 *
 * ── What it does not do ───────────────────────────────────────────────────
 * It does not score, and it does not label people. An extracted term carries
 * **zero weight** until someone promotes it on the taxonomy screen, and there
 * is no per-person LLM archetype or summary. Both would make a person's score
 * depend on a sampled generation, and the score being reproducible and
 * auditable is the whole basis for trusting it.
 *
 * So the model widens the vocabulary; a deterministic table does the maths.
 *
 * ── Privacy ───────────────────────────────────────────────────────────────
 * The target population is minors, so the prompt carries credential-bearing
 * text only. No name, no URL, no location, no school. The model does not need
 * to know who this is to recognise "Davidson Fellow".
 *
 * Plain fetch against the OpenAI-compatible endpoint, so no SDK and the repo
 * keeps zero runtime dependencies. Everything degrades to a no-op without a
 * key: you lose new-term discovery, not the product.
 */

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const TIMEOUT_MS = 30_000;
/**
 * Groq is fast, but a wide batch should not open a socket per profile — and more
 * importantly, concurrency buys nothing at all when the limit is tokens per minute.
 * At 8,000 TPM and roughly 2,000 tokens a call, the ceiling is about four calls a
 * minute no matter how many run at once; three in parallel just converts the same
 * throughput into rate-limit errors. Raise it if your tier is higher.
 */
const CONCURRENCY = envNumber(process.env.ZSCORE_GROQ_CONCURRENCY, 1);
/** Beyond this a profile is padded, not rich. Keeps prompt cost bounded. */
const MAX_CHARS = 6000;
const MAX_TERMS = 12;

/**
 * Output budget.
 *
 * This was 800 and it silently broke extraction. gpt-oss is a reasoning model
 * and its reasoning tokens are completion tokens: measured against a real
 * 6,000-character profile, the model spent **699 of the 800** thinking, left
 * about a hundred for the answer, and came back `finish_reason: "length"` with
 * the JSON cut off mid-object. Groq reports that as `json_validate_failed`,
 * which is why every failed request in the logs shows exactly 800 output tokens.
 *
 * Twelve terms each carrying a quote is roughly 900 tokens of JSON on its own,
 * so the ceiling has to clear that with room to spare rather than sit under it.
 */
const MAX_OUTPUT_TOKENS = 2400;

/**
 * Reading credentials out of text is a reading task, not a thinking task. At low
 * effort the same profile spent 36 reasoning tokens instead of 699 and returned
 * complete JSON.
 *
 * Only the gpt-oss family takes low/medium/high. Qwen takes none/default, and
 * other models reject the parameter outright, so it is sent only where it is
 * known to apply — the model is configurable via ZSCORE_GROQ_MODEL.
 */
function reasoningEffort(model: string): "low" | undefined {
  return /gpt-oss/i.test(model) ? "low" : undefined;
}

function apiKey(): string | null {
  return process.env.ZSCORE_GROQ_API_KEY || process.env.GROQ_API_KEY || null;
}

export function hasGroq(): boolean {
  return Boolean(apiKey());
}

export function groqModel(): string {
  return process.env.ZSCORE_GROQ_MODEL || DEFAULT_MODEL;
}

/**
 * A response schema, enforced server-side.
 *
 * gpt-oss supports `strict: true`, so the shape is guaranteed rather than hoped
 * for. The hand parsers below still run — they enforce the things a schema
 * cannot, like a term being a name and not a sentence — but the whole class of
 * "the model wrapped it in prose" failures is gone at the API.
 */
type Schema = { name: string; schema: Record<string, unknown> };

type ChatResult =
  | { ok: true; content: string }
  | { ok: false; error: string; retryable: boolean; retryAfterMs?: number };

async function chat(
  messages: { role: string; content: string }[],
  schema: Schema
): Promise<ChatResult> {
  const key = apiKey();
  if (!key) return { ok: false, error: "No Groq API key configured.", retryable: false };

  const model = groqModel();
  const effort = reasoningEffort(model);

  // Wait for room under the per-minute limits before sending, rather than being
  // refused and retrying. A spent daily cap is not retryable.
  const room = await reserve(estimateTokens(messages));
  if (!room.ok) return { ok: false, error: room.error, retryable: false };

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        // Zero temperature so the same profile yields the same terms. The score
        // does not depend on this, but a stable review queue does.
        temperature: 0,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        ...(effort ? { reasoning_effort: effort } : {}),
        response_format: { type: "json_schema", json_schema: { ...schema, strict: true } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });

    const body = await res.text();
    // The server's own figure wins: another process on this key spends from the
    // same per-minute budget, and only Groq can see that.
    noteHeaders(res.headers);

    if (!res.ok) {
      // 429 and 5xx are worth asking again; a bad key or a bad request are not,
      // and hammering a rate limit is how a batch turns one 429 into sixty.
      const retryable = res.status === 429 || res.status >= 500;
      return {
        ok: false,
        error: `Groq ${res.status}: ${body.slice(0, 200)}`,
        retryable,
        retryAfterMs: retryAfterFrom(res.headers, body),
      };
    }

    const data = JSON.parse(body) as {
      choices?: { finish_reason?: string; message?: { content?: string } }[];
      usage?: {
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content;

    const out = data.usage?.completion_tokens ?? 0;
    const thinking = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

    // Truncation is the failure this whole file was getting wrong. Name it, with
    // the token split that explains it, rather than letting it surface as
    // unexplained malformed JSON. Nothing logged the budget before, which is why
    // it took reading Groq's own dashboard to notice.
    if (choice?.finish_reason === "length") {
      log.warn("groq.truncated", { model, budget: MAX_OUTPUT_TOKENS, out, thinking });
      return {
        ok: false,
        error: `Groq hit the ${MAX_OUTPUT_TOKENS}-token output budget (${thinking} spent reasoning), so the JSON was cut off.`,
        retryable: false,
      };
    }

    // Warn while there is still headroom, so the next model change or prompt
    // change does not have to fail to be noticed.
    if (out > MAX_OUTPUT_TOKENS * 0.8) {
      log.warn("groq.budget.tight", { model, budget: MAX_OUTPUT_TOKENS, out, thinking });
    }
    if (!content) return { ok: false, error: "Groq returned no content.", retryable: false };
    return { ok: true, content };
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      return { ok: false, error: "Groq timed out.", retryable: true };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not reach Groq.",
      retryable: true,
    };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── Pacing ─────────────────────────────────────────────────────────────── */

/**
 * Stay under the rate limit rather than discovering it.
 *
 * There are FOUR limits per model, not one. On the free plan for
 * openai/gpt-oss-120b they are:
 *
 *     30 requests per minute        1,000 requests per day
 *     8,000 tokens per minute       200,000 tokens per day
 *
 * Any of them refuses the request at the gate: a 429 in about five milliseconds
 * with zero tokens billed. A real run produced a dozen of those interleaved with
 * successes of only ~1,000 tokens each — the signature of a client that is not
 * pacing, not one that is genuinely out of budget. Watching the token headers alone
 * would still have walked straight into the 30-per-minute ceiling.
 *
 * So a sliding one-minute ledger of requests and tokens is kept, plus daily
 * counters, and a call waits for room before it is sent. The response headers then
 * correct the token figure, because the same key may be in use elsewhere.
 *
 * Retrying on 429 remains the backstop, not the mechanism.
 */
const LIMITS = {
  rpm: envNumber(process.env.ZSCORE_GROQ_RPM, 30),
  tpm: envNumber(process.env.ZSCORE_GROQ_TPM, 8_000),
  rpd: envNumber(process.env.ZSCORE_GROQ_RPD, 1_000),
  tpd: envNumber(process.env.ZSCORE_GROQ_TPD, 200_000),
};

/**
 * Spend only this share of the per-minute budget. Token cost is estimated before
 * the call and the estimate can be low, so a margin is what keeps an imprecise
 * guess from becoming a refused request.
 */
const HEADROOM = 0.85;

type Spend = { at: number; tokens: number };

/** Sliding one-minute window. Entries older than a minute are pruned on use. */
const window: Spend[] = [];
const daily = { day: "", requests: 0, tokens: 0 };

/** Calls queue through here, so two workers cannot both spend the last of it. */
let paceGate: Promise<unknown> = Promise.resolve();

/** "7.66s", "1m2.5s", "250ms" — Groq is not consistent, so handle all three. */
function parseReset(v: string | null): number | undefined {
  if (!v) return undefined;
  const ms = v.match(/^([\d.]+)\s*ms$/i);
  if (ms) return Number(ms[1]);
  let total = 0;
  let matched = false;
  for (const [, n, unit] of v.matchAll(/([\d.]+)\s*(m|s)/gi)) {
    matched = true;
    total += Number(n) * (unit.toLowerCase() === "m" ? 60_000 : 1000);
  }
  return matched ? total : undefined;
}

/**
 * Reconcile the ledger with what the server says is left.
 *
 * Authoritative when present: another process on the same key spends from the same
 * budget, and only Groq can see that.
 */
function noteHeaders(headers: Headers) {
  const remaining = Number(headers.get("x-ratelimit-remaining-tokens"));
  if (!Number.isFinite(remaining)) return;

  const used = Math.max(LIMITS.tpm - remaining, 0);
  const ledger = window.reduce((n, s) => n + s.tokens, 0);
  if (used > ledger) {
    // Someone else has been spending. Book the difference so we pace for it.
    const reset = parseReset(headers.get("x-ratelimit-reset-tokens")) ?? 60_000;
    window.push({ at: Date.now() - (60_000 - reset), tokens: used - ledger });
  }
}

/**
 * Roughly what a call will cost. Four characters to a token is the usual rule of
 * thumb; the output allowance is generous relative to what extraction actually
 * returns, because guessing low here means a refused request.
 */
function estimateTokens(messages: { content: string }[]): number {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 4) + 600;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Wait for room, then book it. Rejects only when a daily cap is genuinely spent. */
async function reserve(cost: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const mine = paceGate.then(async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (daily.day !== today()) {
      daily.day = today();
      daily.requests = 0;
      daily.tokens = 0;
    }
    // A daily cap cannot be waited out inside one request, so say so plainly
    // rather than sleeping for hours.
    if (daily.requests >= LIMITS.rpd) {
      return { ok: false, error: `Groq daily request cap reached (${LIMITS.rpd}). Resets at midnight UTC.` };
    }
    if (daily.tokens + cost > LIMITS.tpd) {
      return { ok: false, error: `Groq daily token cap reached (${LIMITS.tpd}). Resets at midnight UTC.` };
    }

    // Up to a minute and a bit of waiting, in small steps, so the window can drain.
    for (let i = 0; i < 130; i++) {
      const now = Date.now();
      while (window.length > 0 && now - window[0].at >= 60_000) window.shift();

      const requests = window.length;
      const tokens = window.reduce((n, s) => n + s.tokens, 0);
      const fits =
        requests + 1 <= Math.floor(LIMITS.rpm * HEADROOM) &&
        tokens + cost <= Math.floor(LIMITS.tpm * HEADROOM);
      if (fits) break;

      // Wait until the oldest entry ages out, which is exactly when room appears.
      const wait = Math.min(Math.max(60_000 - (now - (window[0]?.at ?? now)), 250), 5_000);
      if (i === 0) {
        log.info("groq.paced", { requests, tokens, cost, rpm: LIMITS.rpm, tpm: LIMITS.tpm });
      }
      await sleep(wait);
    }

    window.push({ at: Date.now(), tokens: cost });
    daily.requests += 1;
    daily.tokens += cost;
    return { ok: true };
  });

  paceGate = mine.catch(() => {});
  return mine;
}

/**
 * How long to wait before retrying, taken from what the server actually said.
 *
 * The rate limit that matters here is tokens per minute, and on a small tier it is
 * low: a real run against an 8,000 TPM account produced 429s across most of the
 * batch. A per-minute window needs a wait measured in tens of seconds, so the old
 * exponential backoff of 0.5s, 1s, 2s never cleared it and the batch simply lost
 * those people.
 *
 * Groq puts the figure in the `retry-after` header when it sends one, and always
 * states it in the error body ("Please try again in 20.5s"), so read both.
 */
function retryAfterFrom(headers: Headers, body: string): number | undefined {
  const header = Number(headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;

  const stated = body.match(/try again in\s+([\d.]+)\s*(ms|s)\b/i);
  if (stated) {
    const n = Number(stated[1]);
    if (Number.isFinite(n)) return stated[2].toLowerCase() === "ms" ? n : n * 1000;
  }
  return undefined;
}

/**
 * Up to three attempts, and only for things a second attempt can fix.
 *
 * The previous version returned immediately on any non-200, which meant a rate
 * limit or a truncated response killed the extraction outright — and it retried
 * only on a parse failure, where temperature 0 guarantees the identical answer.
 * That was exactly backwards.
 */
async function chatJson<T>(
  messages: { role: string; content: string }[],
  schema: Schema,
  parse: (raw: unknown) => T | null
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let last = "Groq call failed.";

  // Five attempts, because a tokens-per-minute window can need more than one wait
  // to clear when a whole batch is queued behind it.
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await chat(messages, schema);

    if (r.ok) {
      try {
        const value = parse(JSON.parse(r.content));
        if (value !== null) return { ok: true, value };
        last = "Groq returned JSON that did not hold a usable answer.";
      } catch {
        last = "Groq returned unparseable JSON.";
      }
      // A schema-valid but unusable answer will repeat at temperature 0.
      return { ok: false, error: last };
    }

    last = r.error;
    if (!r.retryable) return { ok: false, error: last };
    // Exponential, unless the server said how long to wait.
    await sleep(r.retryAfterMs ?? 500 * 2 ** attempt);
  }

  return { ok: false, error: last };
}

/* ── Term extraction ────────────────────────────────────────────────────── */

/**
 * The model's job, narrowed.
 *
 * Schools, companies, majors, job titles and counts are read straight off the
 * vendor's structured fields by `lib/extract.ts` — exactly, instantly, and for no
 * tokens. Asking a model to find them was both slower and worse, and its old
 * prompt told it to exclude them anyway, which is why a profile naming Stanford,
 * Google, McKinsey and Jane Street came back with one tag.
 *
 * What is left is judgement, which is what a model is actually for:
 *
 *   1. Which of seventeen honors are worth anything. "Coca-Cola Scholar" yes,
 *      "AP Scholar" and "National Merit Commendation" no.
 *   2. The canonical short name, so one award is one tag.
 *   3. Credentials that appear in prose and nowhere structured — the headline
 *      especially, where "Z Fellow" often appears with no matching experience or
 *      honor entry at all.
 */
const EXTRACT_SYSTEM = `You read a student's profile and list the selective programs, competitions, awards, fellowships and credentials it evidences.

Where to look:
- The HEADLINE is important and easy to overlook. People frequently name a fellowship or programme there and nowhere else on the profile: "Z Fellow", "Neo Scholar", "Thiel Fellow", "YC alum". If the headline claims one, list it.
- Honors, the about text, and project and role descriptions.

Rules:
- Return the canonical short name people actually use. "Regeneron Science Talent Search" -> "STS". "Research Science Institute" -> "RSI". "Coca-Cola Scholarship Recipient" -> "Coca-Cola Scholar".
- If a credential matches one in KNOWN, return the KNOWN spelling exactly. This is how duplicates are prevented, so prefer a KNOWN spelling over your own.
- Only list things the text actually supports. Never infer from a school name alone.
- SKIP the ordinary. Participation, attendance, honor-roll and near-automatic academic recognitions are not credentials: AP Scholar, National Merit Commended or Semifinalist, National Honor Society, Dean's List, perfect attendance.
- SKIP state and district academic recognitions given to hundreds or thousands each year: "Georgia Scholar", "Certificate of Merit", "Governor's Scholar", state seals of biliteracy, district service or spirit awards, and school-level awards named after a person.
- SKIP open-entry organisations and competitions that admit tens of thousands: DECA, FBLA, HOSA, BPA, Key Club, Model UN, Science Olympiad, Science Bowl, AIME, Congressional App Challenge, Girls Who Code, Boy Scouts. Membership in these describes a school district, not a person.
- Skipped items still appear on the profile. They are simply not tags.
- KEEP the selective: named competitions and olympiads, research programmes, selective summer programmes, named fellowships and scholarships with a real bar, grants, and published or patented work.
- KEEP hackathons, which are easy to miss because they are written as a track or a placing rather than a name: "TreeHacks Interaction Track Winner" is TreeHacks, "Second Place CalHacks Audio Track" is CalHacks. Return the event, not the track. Only the major collegiate ones — TreeHacks, CalHacks, HackMIT, Hack the North, PennApps, HackHarvard, MHacks, LA Hacks, and a university's own flagship — and only when the profile shows the person attended or placed.
- KEEP accelerators, fellowships and funds that put money in: Y Combinator, a16z Speedrun, Z Fellows, Neo, Thiel, Sequoia, Pear, South Park Commons, Emergent Ventures. A YC batch is frequently written only as "YC S26" or inside a company name like "Willow (YC S24)".
- Do NOT return schools, universities, employers, majors, or job titles. Those are read from structured fields and returning them creates duplicates.
- At most ${MAX_TERMS} entries. Fewer is better than padded.
- Keep each evidence quote under 20 words. A long quote costs output budget and adds nothing.

Reply with JSON only: {"terms":[{"label":"...","evidence":"short quote from the text"}]}`;

const TERMS_SCHEMA: Schema = {
  name: "extracted_terms",
  schema: {
    type: "object",
    properties: {
      terms: {
        type: "array",
        items: {
          type: "object",
          properties: { label: { type: "string" }, evidence: { type: "string" } },
          required: ["label", "evidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["terms"],
    additionalProperties: false,
  },
};

function parseTerms(raw: unknown): { label: string; evidence: string }[] | null {
  const o = raw as { terms?: unknown };
  if (!Array.isArray(o?.terms)) return null;

  const out: { label: string; evidence: string }[] = [];
  const seen = new Set<string>();
  for (const item of o.terms) {
    const x = (item ?? {}) as Record<string, unknown>;
    const label = typeof x.label === "string" ? x.label.trim() : "";
    // Guard against the model returning a sentence instead of a term.
    if (!label || label.length > 60 || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push({
      label,
      evidence: typeof x.evidence === "string" ? x.evidence.trim().slice(0, 240) : "",
    });
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/**
 * Credential-bearing text only. Deliberately excludes name, school and location.
 *
 * The headline is labelled and put first rather than concatenated into the middle
 * of the blob. It is often the only place a fellowship is named — "Z Fellow" in a
 * headline with no matching experience or honor entry — and an unlabelled first
 * line was easy for the model to read past.
 *
 * Company names are stripped from the role lines. Those are handled structurally,
 * and leaving them in invited the model to return "Google" as a credential.
 */
export function extractableText(p: Person): string {
  const e = p.enriched;
  const headline = (e?.headline || p.headline || "").trim();
  const parts = e
    ? [
        headline ? `HEADLINE: ${headline}` : "",
        e.about ? `ABOUT: ${e.about}` : "",
        ...e.honors.map((h) => [h.title, h.issuedBy, h.description].filter(Boolean).join(" — ")),
        ...e.projects.map((x) => [x.title, x.description].filter(Boolean).join(" — ")),
        // Title and description only, no company.
        ...e.experience.map((x) => [x.title, x.description].filter(Boolean).join(" — ")),
        ...e.volunteering.map((v) => v.role),
        ...e.publications,
        ...e.patents,
        ...e.certifications,
        ...(e.courses ?? []),
        ...(e.recommendations ?? []),
      ]
    : [headline ? `HEADLINE: ${headline}` : "", p.snippet ?? ""];

  return parts.filter(Boolean).join("\n").slice(0, MAX_CHARS);
}

export type Extraction = { slug: string; terms: { label: string; evidence: string }[] };

export async function extractTerms(
  p: Person,
  known: string[]
): Promise<{ ok: true; value: Extraction } | { ok: false; error: string }> {
  const text = extractableText(p);

  /**
   * Worth a call?
   *
   * The old gate was a 40-character minimum on the whole blob, which skipped
   * exactly the case that matters most: a search-only person whose headline reads
   * "Z Fellow | CS @ Stanford" is 24 characters and is the only place that
   * fellowship is ever named. So the gate now asks whether there is anything to
   * read, not how much of it there is.
   */
  const e = p.enriched;
  const headline = (e?.headline || p.headline || "").trim();
  const hasRecords =
    (e?.honors.length ?? 0) > 0 ||
    (e?.projects.length ?? 0) > 0 ||
    (e?.experience.length ?? 0) > 0 ||
    (e?.about ?? "").length > 0;
  if (!hasRecords && headline.length < 12) {
    return { ok: true, value: { slug: p.slug, terms: [] } };
  }

  const r = await chatJson(
    [
      { role: "system", content: EXTRACT_SYSTEM },
      { role: "user", content: `KNOWN: ${known.join(", ")}\n\nPROFILE TEXT:\n${text}` },
    ],
    TERMS_SCHEMA,
    parseTerms
  );

  if (!r.ok) return r;

  /**
   * Check the citation before keeping the claim.
   *
   * The model was already required to quote the text for every term, and nothing
   * ever looked at the quote — the route kept the label and dropped the evidence on
   * the floor. So the one guard the design had against invention was never armed,
   * and Max Fan, a pianist and linguist, was tagged USACO Platinum and USAPhO. Those
   * strings appear nowhere on his profile, nor in the vendor's raw payload. They are
   * both in the KNOWN list the prompt supplies, which is the shape of the failure: a
   * strong STEM profile, a menu of credentials, and a model filling in what such a
   * person usually has.
   *
   * Ungrounded terms are dropped here rather than reported, because there is nothing
   * for a human to adjudicate: the profile does not say it.
   */
  const kept = r.value.filter((t) => groundedIn(text, t.evidence));
  if (kept.length !== r.value.length) {
    log.warn("groq.extract.ungrounded", {
      slug: p.slug,
      dropped: r.value
        .filter((t) => !kept.includes(t))
        .map((t) => t.label)
        .join(", "),
    });
  }
  return { ok: true, value: { slug: p.slug, terms: kept } };
}

/** Lowercase, unaccent, and reduce every run of punctuation or space to one space. */
function flatten(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Does this quote actually come from the profile?
 *
 * Deliberately tolerant, because a model quoting honestly still does not quote
 * cleanly. Measured against real output it stitches two spans with an em dash
 * ("NACLO Invitational Round (2024 & 2025) — Bronze 2025", where the round and the
 * medal are separate lines), prefixes the field it read ("HEADLINE: Stanford CS &
 * Physics"), and elides the middle. Requiring the whole string verbatim would throw
 * away true findings, which is a worse failure than the one being fixed — a dropped
 * credential is invisible, and nobody reviews what they never see.
 *
 * So the quote is split on the joins a model makes, and one usable fragment
 * appearing verbatim is enough. Fabrication has nothing to offer here: an invented
 * credential has no line to cite, so every fragment fails.
 */
export function groundedIn(text: string, evidence: string): boolean {
  const haystack = flatten(text);
  if (!haystack) return false;

  // A leading "HEADLINE:" or "About:" names where the model looked; it is not
  // part of the quotation.
  const body = evidence.replace(/^\s*[a-z ]{3,20}:\s*/i, "");

  const fragments = body
    .split(/\s+[—–-]\s+|[|;•]|\.{3}|…/)
    .map(flatten)
    .filter(usableFragment);

  // Nothing quotable in the quote. The term stands on no evidence at all.
  if (fragments.length === 0) return false;
  return fragments.some((f) => haystack.includes(f));
}

/**
 * Enough of a quote to be evidence of something.
 *
 * Not a length rule, which was the first attempt and was wrong in the direction that
 * matters: it needed twelve characters, and "Z-Fellow" is eight. Tarun Batchu's
 * headline reads "CEO @ Vela | Z-Fellow" and Matthew Wong's says "Y Combinator S26",
 * both verbatim, both real, and both would have been silently discarded — a dropped
 * credential is invisible, so nobody would ever have reviewed it.
 *
 * Two words is enough, however short. One word is enough only when the word
 * distinguishes something: "RSI" does, "Winner" does not, and every profile in this
 * corpus is full of the second kind.
 */
function usableFragment(f: string): boolean {
  const words = f.split(" ").filter(Boolean);
  if (words.length >= 2) return true;
  if (words.length === 0) return false;
  return words[0].length >= 3 && !GENERIC_QUOTE.has(words[0]);
}

/** Words that describe any result rather than name a particular one. */
const GENERIC_QUOTE = new Set([
  "winner",
  "won",
  "finalist",
  "semifinalist",
  "qualifier",
  "place",
  "first",
  "second",
  "third",
  "gold",
  "silver",
  "bronze",
  "medal",
  "medalist",
  "medallist",
  "award",
  "awards",
  "prize",
  "scholar",
  "scholarship",
  "fellow",
  "fellowship",
  "member",
  "national",
  "international",
  "honors",
  "honours",
  "champion",
  "top",
  "recipient",
  "participant",
  "competition",
  "challenge",
  "research",
  "intern",
  "internship",
]);

/** Bounded-concurrency map, so a wide batch does not stampede the API. */
export async function extractMany(
  people: Person[],
  known: string[]
): Promise<{ results: Extraction[]; errors: string[] }> {
  const results: Extraction[] = [];
  const errors: string[] = [];
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= people.length) return;
      const r = await extractTerms(people[i], known);
      if (r.ok) results.push(r.value);
      else errors.push(r.error);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, people.length) }, worker)
  );
  return { results, errors };
}

/* ── Alias resolution, asked once per genuinely new label ──────────────── */

/**
 * The last step of dedupe, and the only one a model is needed for.
 *
 * `normalizeKey` already folds case, punctuation, "&"/"and" and the noise words,
 * so "Coca-Cola Scholarship Recipient" and "COCA-COLA SCHOLAR" resolve to the
 * same tag with no model involved. Bigram similarity then catches typos.
 *
 * Neither catches a brand synonym. "coke" against "coca cola" scores about 0.18,
 * so no string method will ever merge "Coke Scholar" with "Coca-Cola Scholar" —
 * that needs world knowledge. This is where it is asked, once per new label ever,
 * and the answer is stored as an alias so it is deterministic from then on.
 *
 * Asked in one batched call for a whole run rather than per person, and scoped to
 * one facet's labels rather than the full registry.
 */
const ALIAS_SYSTEM = `You decide whether each NEW label names the same real-world thing as one of the EXISTING labels.

Rules:
- Same thing means the same award, programme, company or school, however differently written. "Coke Scholar" and "Coca-Cola Scholar" are the same. "STS" and "Regeneron Science Talent Search" are the same.
- Different levels, years or tiers of one programme are DIFFERENT things: "USACO Platinum" is not "USACO Gold". Two distinct awards from the same foundation are DIFFERENT.
- If you are not confident, say null. A wrong merge destroys a distinction permanently; leaving two entries is recoverable.
- Return one entry per NEW label, in the same order.

Reply with JSON only: {"matches":[{"new":"...","existing":"..."}]} where existing is an EXISTING label copied exactly, or null.`;

const ALIAS_SCHEMA: Schema = {
  name: "alias_matches",
  schema: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            new: { type: "string" },
            // Nullable so "no match" is expressible without a sentinel string.
            existing: { type: ["string", "null"] },
          },
          required: ["new", "existing"],
          additionalProperties: false,
        },
      },
    },
    required: ["matches"],
    additionalProperties: false,
  },
};

export type AliasMatch = { label: string; existing: string | null };

function parseAliases(raw: unknown): AliasMatch[] | null {
  const o = raw as { matches?: unknown };
  if (!Array.isArray(o?.matches)) return null;
  const out: AliasMatch[] = [];
  for (const item of o.matches) {
    const x = (item ?? {}) as Record<string, unknown>;
    const label = typeof x.new === "string" ? x.new.trim() : "";
    if (!label) continue;
    out.push({
      label,
      existing: typeof x.existing === "string" && x.existing.trim() ? x.existing.trim() : null,
    });
  }
  return out;
}

/** At most this many existing labels are shown, newest-relevant first. */
const ALIAS_CANDIDATES = 120;

export async function resolveAliases(
  fresh: string[],
  existing: string[]
): Promise<{ ok: true; value: AliasMatch[] } | { ok: false; error: string }> {
  if (fresh.length === 0) return { ok: true, value: [] };
  // Nothing to match against: everything is genuinely new.
  if (existing.length === 0) {
    return { ok: true, value: fresh.map((label) => ({ label, existing: null })) };
  }

  return chatJson(
    [
      { role: "system", content: ALIAS_SYSTEM },
      {
        role: "user",
        content: `EXISTING: ${existing.slice(0, ALIAS_CANDIDATES).join(", ")}\n\nNEW: ${fresh.join(", ")}`,
      },
    ],
    ALIAS_SCHEMA,
    parseAliases
  );
}

/* ── Classification, asked once per term ────────────────────────────────── */

const CLASSIFY_SYSTEM = `You file one thing found on a profile: what kind of thing it is, which talent cluster it votes for, what it is worth, and whether you are sure.

Sections:
- program: anything selective that picked you — a programme, competition, olympiad, hackathon, award or scholarship
- accelerator: an accelerator, fellowship or fund that backs people with money
- startup: an early-stage company
- lab: a named research group at a university or national laboratory
- club: a student organisation or society
- company: an established employer
- org: a nonprofit or community organisation

Clusters:
${ARCHETYPES.map((a) => `- ${a.id}: ${a.blurb}`).join("\n")}
- none: real signal, but not diagnostic of a talent type. Use for need-based or demographic scholarships.

Weight is 0.0 to 2.0. This taxonomy values real-world validation above competitions,
and competitions above school. Match these anchors:

  2.0  Y Combinator, a16z, Sequoia, Founders Fund, Thiel Fellowship, Z Fellows,
       IMO/IOI — a top fund backing you, or the global ceiling of a competition
  1.5  Neo, Pear, South Park Commons, Afore Capital, Battery Ventures, a named
       venture fund most people in tech would recognise
  1.4  Google, Meta, OpenAI, Anthropic, Jane Street, Citadel, McKinsey, NASA,
       Palantir, Bloomberg — a company anyone in the industry knows
  1.2  a real funded startup; a national programme taking a few hundred a year
  1.0  a student-run fund, USACO Platinum, PROMYS
  0.7  a named research lab; a selective student society; a strong regional employer
  0.5  a semifinalist round, QuestBridge, an unremarkable startup
  0.3  a hackathon, an activity, a weekend build
  0.2  a major, a job title, a two-week summer course
  0.0  anything tens of thousands of people a year hold

Be hard to impress. Weight is about how rare the thing is, not how good it sounds.
DECA, FBLA, AIME, Science Olympiad, National Honor Society, AP Scholar and anything
like them are 0.0 — a tag for them says nothing about the person holding it.

Weigh the thing itself, not what it implies. One company out of a batch is not worth
what the accelerator is worth: the accelerator is scored separately, so pricing the
company the same counts it twice.

Set "sure" to true only when you recognise the thing by name and would defend the
weight. A name you are guessing at goes to a human instead, so false is the safe
answer and costs nothing.

Reply with JSON only: {"facet":"company","cluster":"quant","weight":1.4,"sure":true,"why":"one short sentence"}`;

const CLASSIFY_SCHEMA: Schema = {
  name: "classification",
  schema: {
    type: "object",
    properties: {
      facet: {
        type: "string",
        enum: [
          "program",
          "accelerator",
          "startup",
          "lab",
          "club",
          "company",
          "org",
        ],
      },
      cluster: { type: "string", enum: [...ARCHETYPES.map((a) => a.id), "none"] },
      weight: { type: "number" },
      sure: { type: "boolean" },
      why: { type: "string" },
    },
    required: ["facet", "cluster", "weight", "sure", "why"],
    additionalProperties: false,
  },
};

export type Classification = {
  /** Which section of the taxonomy it belongs in. A suggestion, edited before it lands. */
  facet: TagFacet | null;
  cluster: Archetype | null;
  weight: number;
  /**
   * Whether the model recognised the thing by name and would defend the weight.
   *
   * The gate on adding a tag without a human. False is the safe answer and costs
   * nothing: the term goes to the review queue instead of into the scoring
   * vocabulary, which is where a guess belongs.
   */
  sure: boolean;
  why: string;
};

function parseClassification(raw: unknown): Classification | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (!("weight" in o)) return null;

  const weight = Number(o.weight);
  if (!Number.isFinite(weight)) return null;

  return {
    facet: isTagFacet(o.facet) ? o.facet : null,
    sure: o.sure === true,
    cluster: isArchetype(o.cluster) ? o.cluster : null,
    // Clamp rather than reject: a model returning 5 means "high", not "invalid".
    weight: Math.min(Math.max(Math.round(weight * 10) / 10, 0), 2),
    why: typeof o.why === "string" ? o.why.trim().slice(0, 200) : "",
  };
}

/**
 * Asked when a term is promoted, not per person. One call per term for the
 * lifetime of that term, and the answer is a suggestion you edit before it
 * lands.
 */
export async function suggestClassification(
  term: string
): Promise<{ ok: true; value: Classification } | { ok: false; error: string }> {
  return chatJson(
    [
      { role: "system", content: CLASSIFY_SYSTEM },
      { role: "user", content: `Credential: ${term}` },
    ],
    CLASSIFY_SCHEMA,
    parseClassification
  );
}
