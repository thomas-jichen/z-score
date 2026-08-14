/**
 * Structured server logging.
 *
 * The reason this exists rather than bare console.log: the first surprising
 * Apify or Groq bill is unexplainable without a per-call record of who ran
 * what, how many, and what it cost. Vercel's log drain reads JSON lines.
 *
 * Candidate PII never goes in. The population is minors, logs are retained by
 * the platform outside our control, and a slug or a count is enough to
 * reconstruct what happened. Slugs are truncated for the same reason.
 */

type Level = "info" | "warn" | "error";

type Fields = Record<string, string | number | boolean | undefined>;

function emit(level: Level, event: string, fields: Fields) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    level,
    event,
    ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields: Fields = {}) => emit("info", event, fields),
  warn: (event: string, fields: Fields = {}) => emit("warn", event, fields),
  error: (event: string, fields: Fields = {}) => emit("error", event, fields),
};

/**
 * Wrap a paid call so its cost and duration are always recorded, including on
 * the failure path — a failed Apify run is still billable.
 */
export async function timed<T>(
  event: string,
  fields: Fields,
  fn: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  try {
    const out = await fn();
    log.info(event, { ...fields, ms: Date.now() - started, ok: true });
    return out;
  } catch (e) {
    log.error(event, {
      ...fields,
      ms: Date.now() - started,
      ok: false,
      error: e instanceof Error ? e.message : "unknown",
    });
    throw e;
  }
}
