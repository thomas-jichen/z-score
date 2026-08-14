import type { Archetype } from "./clusters";
import { ARCHETYPES, isArchetype } from "./clusters";
import type { Person } from "./people";

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
/** Groq is fast, but a 250-profile batch should not open 250 sockets. */
const CONCURRENCY = 3;
/** Beyond this a profile is padded, not rich. Keeps prompt cost bounded. */
const MAX_CHARS = 6000;
const MAX_TERMS = 12;

function apiKey(): string | null {
  return process.env.ZSCORE_GROQ_API_KEY || process.env.GROQ_API_KEY || null;
}

export function hasGroq(): boolean {
  return Boolean(apiKey());
}

export function groqModel(): string {
  return process.env.ZSCORE_GROQ_MODEL || DEFAULT_MODEL;
}

type ChatResult = { ok: true; content: string } | { ok: false; error: string };

async function chat(messages: { role: string; content: string }[]): Promise<ChatResult> {
  const key = apiKey();
  if (!key) return { ok: false, error: "No Groq API key configured." };

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: groqModel(),
        messages,
        // Zero temperature so the same profile yields the same terms. The score
        // does not depend on this, but a stable review queue does.
        temperature: 0,
        max_completion_tokens: 800,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });

    const body = await res.text();
    if (!res.ok) return { ok: false, error: `Groq ${res.status}: ${body.slice(0, 200)}` };

    const data = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: "Groq returned no content." };
    return { ok: true, content };
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      return { ok: false, error: "Groq timed out." };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach Groq." };
  }
}

/** One retry, because JSON mode still occasionally wraps or truncates. */
async function chatJson<T>(
  messages: { role: string; content: string }[],
  parse: (raw: unknown) => T | null
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat(messages);
    if (!r.ok) {
      // A transport failure will not be fixed by asking again immediately.
      return { ok: false, error: r.error };
    }
    try {
      const value = parse(JSON.parse(r.content));
      if (value !== null) return { ok: true, value };
    } catch {
      /* fall through to the retry */
    }
  }
  return { ok: false, error: "Groq returned malformed JSON twice." };
}

/* ── Term extraction ────────────────────────────────────────────────────── */

const EXTRACT_SYSTEM = `You read a student's profile text and list the selective programs, competitions, awards, fellowships and credentials it evidences.

Rules:
- Return the canonical short name people actually use. "Regeneron Science Talent Search" -> "STS". "Research Science Institute" -> "RSI".
- If a credential matches one in KNOWN, return the KNOWN spelling exactly.
- Only list things the text actually supports. Never infer from a school name or a job title alone.
- Exclude: school and university names, ordinary job titles, generic skills, club membership with no selection, and anything self-awarded.
- Include: named competitions, olympiads, research programs, selective summer programs, fellowships, grants, scholarships, and published work.
- At most ${MAX_TERMS} entries. Fewer is better than padded.

Reply with JSON only: {"terms":[{"label":"...","evidence":"short quote from the text"}]}`;

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

/** Credential-bearing text only. Deliberately excludes name, school and location. */
export function extractableText(p: Person): string {
  const e = p.enriched;
  const parts = e
    ? [
        e.headline,
        e.about,
        ...e.honors.map((h) => [h.title, h.issuedBy, h.description].filter(Boolean).join(" — ")),
        ...e.projects.map((x) => [x.title, x.description].filter(Boolean).join(" — ")),
        ...e.experience.map((x) => [x.title, x.description].filter(Boolean).join(" — ")),
        ...e.volunteering.map((v) => v.role),
        ...e.publications,
        ...e.patents,
        ...e.certifications,
      ]
    : [p.headline, p.snippet];

  return parts.filter(Boolean).join("\n").slice(0, MAX_CHARS);
}

export type Extraction = { slug: string; terms: { label: string; evidence: string }[] };

export async function extractTerms(
  p: Person,
  known: string[]
): Promise<{ ok: true; value: Extraction } | { ok: false; error: string }> {
  const text = extractableText(p);
  // Two lines of headline is not worth a call.
  if (text.trim().length < 40) return { ok: true, value: { slug: p.slug, terms: [] } };

  const r = await chatJson(
    [
      { role: "system", content: EXTRACT_SYSTEM },
      { role: "user", content: `KNOWN: ${known.join(", ")}\n\nPROFILE TEXT:\n${text}` },
    ],
    parseTerms
  );

  if (!r.ok) return r;
  return { ok: true, value: { slug: p.slug, terms: r.value } };
}

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

/* ── Classification, asked once per term ────────────────────────────────── */

const CLASSIFY_SYSTEM = `You assign a talent cluster and a starting weight to one credential.

Clusters:
${ARCHETYPES.map((a) => `- ${a.id}: ${a.blurb}`).join("\n")}
- null: real signal, but not diagnostic of a talent type. Use for need-based or demographic scholarships.

Weight is 0.0 to 2.0 and means "how much does holding this predict exceptional early-career talent".
For calibration: IMO is 2.0, RSI is 1.8, ISEF is 1.4, USAMO is 1.3, Hack Club is 0.7, TASP is 0.6.

Reply with JSON only: {"cluster":"olympiad"|"research"|"builder"|"founder"|"quant"|"scholar"|null,"weight":1.2,"why":"one short sentence"}`;

export type Classification = { cluster: Archetype | null; weight: number; why: string };

function parseClassification(raw: unknown): Classification | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (!("weight" in o)) return null;

  const weight = Number(o.weight);
  if (!Number.isFinite(weight)) return null;

  return {
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
    parseClassification
  );
}
