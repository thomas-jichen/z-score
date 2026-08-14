import { toSlug } from "./enrichment";

/**
 * Request body guards.
 *
 * Every route used to merge whatever JSON arrived straight into stored state.
 * A single malformed or oversized body could then poison a teammate's document
 * or push the store past what it accepts, which fails every subsequent write at
 * once rather than degrading. These are cheap and they run before anything is
 * read from the store.
 */

/** Above this a body is a mistake or an attack, not a queue operation. */
export const MAX_BODY_BYTES = 2_000_000;

export type Bad = { error: string; status: number };

export function isBad(v: unknown): v is Bad {
  return typeof v === "object" && v !== null && "error" in v && "status" in v;
}

/** Read and size-check a JSON body in one step. */
export async function readJson<T>(req: Request): Promise<T | Bad> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return { error: "Request body is too large.", status: 413 };
  }

  const text = await req.text().catch(() => null);
  if (text === null) return { error: "Could not read the request body.", status: 400 };
  if (text.length > MAX_BODY_BYTES) {
    return { error: "Request body is too large.", status: 413 };
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return { error: "Invalid JSON.", status: 400 };
  }
}

/** Canonicalise and dedupe a slug list, rejecting anything unusable. */
export function cleanSlugs(raw: unknown, max: number): string[] | Bad {
  if (!Array.isArray(raw)) return { error: "Expected an array of profiles.", status: 400 };
  if (raw.length > max) return { error: `At most ${max} profiles per request.`, status: 400 };

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const slug = toSlug(item);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }

  if (out.length === 0) return { error: "No valid profiles in that list.", status: 400 };
  return out;
}

export function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

export function bounded(v: unknown, lo: number, hi: number): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, lo), hi);
}

/** A string list with per-item length and total count caps. */
export function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    if (!s) continue;
    out.push(s.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}
