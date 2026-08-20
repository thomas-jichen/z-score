import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Tiny key/value store with two backends.
 *
 *   redis  — any Upstash-compatible REST endpoint. The Vercel Marketplace
 *            integration sets these variables for you, so deploying with an
 *            Upstash Redis attached needs no code change.
 *   file   — a JSON file under .data/, for local development.
 *
 * Vercel's filesystem is read-only outside /tmp and /tmp is per-instance, so
 * the file backend is development only. `storeKind()` reports which one is
 * live and the app surfaces it, rather than silently losing writes.
 */

type Kind = "redis" | "file";

function redisConfig(): { url: string; token: string } | null {
  const url =
    process.env.ZSCORE_REDIS_REST_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL;
  const token =
    process.env.ZSCORE_REDIS_REST_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

export function storeKind(): Kind {
  return redisConfig() ? "redis" : "file";
}

/** True when writes will not survive, so the UI can say so plainly. */
export function storeIsEphemeral(): boolean {
  return storeKind() === "file" && process.env.VERCEL === "1";
}

// ── Redis (Upstash REST) ──────────────────────────────────────────────────
// One POST to the root endpoint with a command array handles values of any
// size, unlike the path-based form.

async function redisCommand<T>(cmd: unknown[]): Promise<T | null> {
  const cfg = redisConfig();
  if (!cfg) return null;

  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Redis ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  const data = (await res.json()) as { result?: unknown };
  return (data.result ?? null) as T | null;
}

// ── File (local dev) ──────────────────────────────────────────────────────
//
// Every key lives in one JSON blob, so a write is a read-modify-write of the
// whole thing. With two concurrent writers — /api/state and /api/enrich — that
// loses updates: both read, then the later write overwrites the earlier one's
// key. Serialising through a lock makes each set() atomic, which is enough
// because dev runs a single Node process.
//
// Redis needs none of this: SET touches one key and does not read the others.

const FILE = path.join(process.cwd(), ".data", "store.json");

let fileLock: Promise<unknown> = Promise.resolve();

/** Run `fn` after every previously queued file operation has finished. */
function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = fileLock.then(fn, fn);
  // Keep the chain alive even if this operation rejects.
  fileLock = run.catch(() => {});
  return run;
}

async function readFileStore(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeFileStore(all: Record<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(all, null, 2), "utf8");
}

// ── Public API ────────────────────────────────────────────────────────────

export async function get<T>(key: string): Promise<T | null> {
  if (storeKind() === "redis") {
    const raw = await redisCommand<string>(["GET", key]);
    return raw ? (JSON.parse(raw) as T) : null;
  }
  const all = await withFileLock(readFileStore);
  return all[key] ? (JSON.parse(all[key]) as T) : null;
}

export async function set<T>(key: string, value: T): Promise<void> {
  const raw = JSON.stringify(value);
  if (storeKind() === "redis") {
    await redisCommand(["SET", key, raw]);
    return;
  }
  // Read and write inside one lock, or a concurrent set() drops this key.
  await withFileLock(async () => {
    const all = await readFileStore();
    all[key] = raw;
    await writeFileStore(all);
  });
}

export async function keys(prefix: string): Promise<string[]> {
  if (storeKind() === "redis") {
    return (await redisCommand<string[]>(["KEYS", `${prefix}*`])) ?? [];
  }
  const all = await withFileLock(readFileStore);
  return Object.keys(all).filter((k) => k.startsWith(prefix));
}

export async function del(key: string): Promise<void> {
  if (storeKind() === "redis") {
    await redisCommand(["DEL", key]);
    return;
  }
  await withFileLock(async () => {
    const all = await readFileStore();
    delete all[key];
    delete all[hashPrefix(key)];
    await writeFileStore(all);
  });
}

/**
 * Increment a counter with a TTL, for rate limits and the daily spend cap.
 * The expiry is only set on first write, so a window does not slide forward
 * every time it is hit.
 */
/**
 * Claim a name, or find it already claimed. Returns whether this caller won.
 *
 * A real lock, not a counter. `bump` cannot do this job: its window is a
 * timestamp in the key, so two callers either side of a minute boundary both
 * think they are first — which for the campaign loop means paying Apify twice.
 *
 * The TTL is the whole safety story: a holder that crashes without releasing
 * blocks the lock for at most that long, so it is set to the function timeout
 * rather than to anything optimistic.
 */
export async function setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  if (storeKind() === "redis") {
    const res = await redisCommand<string | null>([
      "SET",
      key,
      JSON.stringify(value),
      "NX",
      "EX",
      String(ttlSeconds),
    ]);
    return res === "OK";
  }

  // The file backend serialises every write, so read-then-write is atomic here.
  return withFileLock(async () => {
    const all = await readFileStore();
    const held = all[key];
    if (held !== undefined) {
      const expires = all[`${key}::exp`];
      const stillHeld = !expires || Number(JSON.parse(expires)) > Date.now();
      if (stillHeld) return false;
    }
    all[key] = JSON.stringify(value);
    all[`${key}::exp`] = JSON.stringify(Date.now() + ttlSeconds * 1000);
    await writeFileStore(all);
    return true;
  });
}

export async function bump(key: string, ttlSeconds: number): Promise<number> {
  if (storeKind() === "redis") {
    const n = (await redisCommand<number>(["INCR", key])) ?? 1;
    if (n === 1) await redisCommand(["EXPIRE", key, ttlSeconds]);
    return n;
  }
  return withFileLock(async () => {
    const all = await readFileStore();
    const raw = all[key] ? (JSON.parse(all[key]) as { n: number; exp: number }) : null;
    const nowMs = Date.now();
    const live = raw && raw.exp > nowMs ? raw : null;
    const next = { n: (live?.n ?? 0) + 1, exp: live?.exp ?? nowMs + ttlSeconds * 1000 };
    all[key] = JSON.stringify(next);
    await writeFileStore(all);
    return next.n;
  });
}

// ── Hashes ────────────────────────────────────────────────────────────────
//
// The roster is a hash rather than one JSON document, because HSET writes a
// single field atomically. Pinning one person is then a small write, instead of
// reading a multi-megabyte document, merging, and writing all of it back —
// which is what a document-per-teammate forced, and it got worse with every
// profile enriched.
//
// The file backend keeps each hash as a nested object under its own key. It
// still rewrites the file, but every operation runs inside withFileLock, so
// concurrent writers cannot lose each other's fields. Dev is a single process,
// which is the only place this backend is used.

/** Fields live under a distinct key so a hash can never collide with a string. */
function hashPrefix(key: string): string {
  return `${key}::hash`;
}

async function readHashFile(key: string): Promise<Record<string, string>> {
  const all = await readFileStore();
  const raw = all[hashPrefix(key)];
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}

export async function hgetall<T>(key: string): Promise<Record<string, T>> {
  if (storeKind() === "redis") {
    // Upstash returns a flat [field, value, field, value] array.
    const flat = (await redisCommand<unknown[]>(["HGETALL", key])) ?? [];
    const out: Record<string, T> = {};
    if (Array.isArray(flat)) {
      for (let i = 0; i < flat.length - 1; i += 2) {
        const field = String(flat[i]);
        try {
          out[field] = JSON.parse(String(flat[i + 1])) as T;
        } catch {
          // One corrupt field must not take the whole roster down with it.
        }
      }
    }
    return out;
  }

  const raw = await withFileLock(() => readHashFile(key));
  const out: Record<string, T> = {};
  for (const [field, value] of Object.entries(raw)) {
    try {
      out[field] = JSON.parse(value) as T;
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Just the field names.
 *
 * `hgetall` on the roster returns up to two thousand enriched profiles, several
 * megabytes of JSON, and the commonest reason to touch it is only ever to ask
 * "do we already have this person". The campaign loop asks that of a hundred
 * slugs a day, so it asks for the keys.
 */
export async function hkeys(key: string): Promise<string[]> {
  if (storeKind() === "redis") {
    const raw = (await redisCommand<unknown[]>(["HKEYS", key])) ?? [];
    return Array.isArray(raw) ? raw.map(String) : [];
  }
  return Object.keys(await withFileLock(() => readHashFile(key)));
}

export async function hget<T>(key: string, field: string): Promise<T | null> {
  if (storeKind() === "redis") {
    const raw = await redisCommand<string>(["HGET", key, field]);
    return raw ? (JSON.parse(raw) as T) : null;
  }
  const raw = await withFileLock(() => readHashFile(key));
  return raw[field] ? (JSON.parse(raw[field]) as T) : null;
}

/** Write one or many fields. One round trip either way. */
export async function hset<T>(key: string, values: Record<string, T>): Promise<void> {
  const pairs = Object.entries(values);
  if (pairs.length === 0) return;

  if (storeKind() === "redis") {
    await redisCommand(["HSET", key, ...pairs.flatMap(([f, v]) => [f, JSON.stringify(v)])]);
    return;
  }
  await withFileLock(async () => {
    const all = await readFileStore();
    const hkey = hashPrefix(key);
    const hash = all[hkey] ? (JSON.parse(all[hkey]) as Record<string, string>) : {};
    for (const [f, v] of pairs) hash[f] = JSON.stringify(v);
    all[hkey] = JSON.stringify(hash);
    await writeFileStore(all);
  });
}

export async function hdel(key: string, fields: string[]): Promise<void> {
  if (fields.length === 0) return;

  if (storeKind() === "redis") {
    await redisCommand(["HDEL", key, ...fields]);
    return;
  }
  await withFileLock(async () => {
    const all = await readFileStore();
    const hkey = hashPrefix(key);
    if (!all[hkey]) return;
    const hash = JSON.parse(all[hkey]) as Record<string, string>;
    for (const f of fields) delete hash[f];
    all[hkey] = JSON.stringify(hash);
    await writeFileStore(all);
  });
}
