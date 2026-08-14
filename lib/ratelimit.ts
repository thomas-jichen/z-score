import type { ProfileId } from "./profiles";
import { bump } from "./store";
import { log } from "./log";

/**
 * Rate limits and a hard daily spend cap.
 *
 * Three endpoints cost real money: /api/sweep hits Serper, /api/enrich hits
 * Apify at $4 per 1,000 profiles, and /api/tag hits Groq. A loop in client code
 * against a live Apify token is a bill, not a bug report, so the ceiling lives
 * on the server where the client cannot talk it out of refusing.
 *
 * The enrichment cap counts **profiles**, not requests, because that is what is
 * billed. Refusing is always explicit — the UI says what the cap is and when it
 * resets, rather than silently truncating a batch.
 */

const DAY_SECONDS = 60 * 60 * 24;
const HOUR_SECONDS = 60 * 60;

/**
 * Read a numeric setting from the environment, falling back when it is unusable.
 *
 * `Number(process.env.X ?? 500)` looks right and is not: `??` only catches null
 * and undefined, so an env var **present but empty** — which is what a blank field
 * in the Vercel dashboard produces — yields `Number("")`, which is `0`. That
 * turned the daily enrichment cap into zero on production and refused every run
 * with "Daily enrichment cap reached (0 profiles)".
 *
 * A non-positive or non-numeric value is a misconfiguration, never an intent, so
 * it falls back rather than silently disabling the feature it guards.
 */
export function envNumber(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Profiles per teammate per day. 500 is about $2 at HarvestAPI's no-email rate. */
export const DAILY_PROFILE_CAP = envNumber(process.env.ZSCORE_DAILY_PROFILE_CAP, 500);
/** Searches per teammate per hour. Generous; a human cannot out-click this. */
export const HOURLY_SEARCH_CAP = 120;
/** Tagger calls per teammate per hour. */
export const HOURLY_TAG_CAP = 600;

/** Same bucket for a whole UTC day, so the window does not slide. */
function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function hourStamp(): string {
  return new Date().toISOString().slice(0, 13);
}

export type Allowed = { ok: true; used: number; cap: number };
export type Denied = { ok: false; error: string; status: 429 };

/**
 * Reserve `count` units against a cap.
 *
 * The counter is incremented before the work runs, so a crash mid-run cannot
 * hand back free quota. `bump` is called once per unit for the profile cap
 * because Upstash INCR has no INCRBY-with-TTL-on-first-write primitive here;
 * batches are small enough (≤250) that this stays one round trip per profile
 * only in the worst case, and the alternative is an untracked spend.
 */
async function reserve(
  key: string,
  ttl: number,
  cap: number,
  count: number,
  label: string
): Promise<Allowed | Denied> {
  if (count <= 0) return { ok: true, used: 0, cap };

  let used = 0;
  for (let i = 0; i < count; i++) {
    used = await bump(key, ttl);
    if (used > cap) {
      log.warn("ratelimit.denied", { limit: label, cap, used });
      return {
        ok: false,
        status: 429,
        error:
          label === "profiles"
            ? `Daily enrichment cap reached (${cap} profiles). This resets at midnight UTC. Raise ZSCORE_DAILY_PROFILE_CAP if that is deliberate.`
            : `Rate limit reached (${cap} per hour). Try again shortly.`,
      };
    }
  }
  return { ok: true, used, cap };
}

export function reserveProfiles(profile: ProfileId, count: number) {
  return reserve(
    `zscore:cap:profiles:${profile}:${dayStamp()}`,
    DAY_SECONDS,
    DAILY_PROFILE_CAP,
    count,
    "profiles"
  );
}

export function reserveSearch(profile: ProfileId) {
  return reserve(
    `zscore:cap:search:${profile}:${hourStamp()}`,
    HOUR_SECONDS,
    HOURLY_SEARCH_CAP,
    1,
    "search"
  );
}

export function reserveTagging(profile: ProfileId, count: number) {
  return reserve(
    `zscore:cap:tag:${profile}:${hourStamp()}`,
    HOUR_SECONDS,
    HOURLY_TAG_CAP,
    count,
    "tagging"
  );
}
