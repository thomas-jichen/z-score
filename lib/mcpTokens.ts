import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isProfileId, type ProfileId } from "./profiles";
import { hdel, hget, hgetall, hset } from "./store";

/**
 * Bearer tokens for the MCP server.
 *
 * ── Why not the session cookie ────────────────────────────────────────────
 * `resolveProfile` reads two cookies, one of them httpOnly and HMAC-signed with a
 * fourteen-day life. Claude Code registers a remote MCP server with a static
 * header, has no cookie jar, and would need re-registering every fortnight. So
 * the agent gets its own credential: long-lived, revocable one at a time, and
 * attributable to a person rather than to "somebody who knew the passphrase".
 *
 * ── Why plain SHA-256 and no KDF ──────────────────────────────────────────
 * A password needs a slow hash because it is short, human-chosen and guessable.
 * This is 256 bits from `randomBytes`, so there is nothing to guess and a work
 * factor would only slow down every legitimate call. What matters instead is that
 * the stored form is not usable as a credential, which a single hash gives.
 *
 * The hash **is** the field key. Storing it in the value as well would be two
 * copies of one fact, free to disagree.
 */

export const TOKENS_KEY = "zscore:team:tokens";
export const TOKEN_PREFIX = "zsk_";

/** What is kept about a token. Never the token. */
export type TokenRecord = {
  owner: ProfileId;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
};

export type TokenListing = TokenRecord & { hash: string };

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Mint one. The plain token is returned exactly once and never stored, so this
 * return value is the only chance anybody has to copy it.
 */
export async function mintToken(
  owner: ProfileId,
  label: string
): Promise<{ token: string; hash: string; record: TokenRecord }> {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const hash = hashToken(token);
  const record: TokenRecord = {
    owner,
    label: label.trim().slice(0, 60) || "Claude",
    createdAt: new Date().toISOString(),
  };
  await hset(TOKENS_KEY, { [hash]: record });
  return { token, hash, record };
}

/**
 * Resolve a bearer to whoever owns it, or null.
 *
 * One `hget` on the hashed value — the lookup is by key, so an unknown token
 * costs one round trip and reveals nothing. The constant-time compare is belt and
 * braces given the key lookup already happened, but it costs nothing and keeps
 * the habit consistent with lib/auth.ts.
 */
export async function verifyMcpToken(raw: string | undefined): Promise<TokenRecord | null> {
  if (!raw || !raw.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(raw);
  const record = await hget<TokenRecord>(TOKENS_KEY, hash);
  if (!record || !isProfileId(record.owner)) return null;

  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(hashToken(raw), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  /**
   * "Last used" is written at most once an hour.
   *
   * Every tool call would otherwise be a store write, which turns a read-only
   * tool into a write and doubles the round trips on the busiest path here. An
   * hour is precise enough to answer "is this token still in use".
   */
  const stale = !record.lastUsedAt || Date.now() - Date.parse(record.lastUsedAt) > 3_600_000;
  if (stale) {
    await hset(TOKENS_KEY, { [hash]: { ...record, lastUsedAt: new Date().toISOString() } }).catch(
      () => {}
    );
  }
  return record;
}

export async function listTokens(): Promise<TokenListing[]> {
  const all = await hgetall<TokenRecord>(TOKENS_KEY);
  return Object.entries(all)
    .filter(([, r]) => isProfileId(r?.owner))
    .map(([hash, r]) => ({ ...r, hash }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Revocation is immediate: the next call finds nothing under that key. */
export async function revokeToken(hash: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return;
  await hdel(TOKENS_KEY, [hash]);
}
