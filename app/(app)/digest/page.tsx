"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { useApp } from "@/components/AppState";
import { archetypeLabel, dominantSignals, formatSigma } from "@/lib/zscore";
import { EmptyState, MarkControl, PolymathBadge, type MarkChange } from "@/components/primitives";

/**
 * The digest. Primary surface, and the one that may ship as email.
 *
 * Structure stays email-safe: rows are <table>, nothing load-bearing depends on
 * flex or grid, and radius stays at 4px because Outlook drops pill radius and
 * inset shadows. The page itself runs the same width as every other screen.
 *
 * The batch is simply the top ten queued people by score. Screening comes later;
 * until it exists, "highest signal" is the honest description of what this is.
 */

const BATCH_SIZE = 10;

export default function DigestPage() {
  const { queue, marks, knownCount, state, team, patch, mark, loading, error } = useApp();

  // Capture the previous visit before overwriting it, or "new since" would
  // always be empty — the write lands before the render that reads it.
  const seenBefore = useRef<string | null>(null);
  const stamped = useRef(false);

  useEffect(() => {
    if (loading || stamped.current) return;
    stamped.current = true;
    seenBefore.current = state.digestSeenAt;
    patch({ digestSeenAt: new Date().toISOString() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const batch = useMemo(() => queue.slice(0, BATCH_SIZE), [queue]);

  const isNew = (surfacedAt: string) =>
    Boolean(seenBefore.current && surfacedAt > seenBefore.current);
  const newCount = batch.filter((c) => isNew(c.surfaced_at)).length;

  function rate(slug: string, change: MarkChange) {
    void mark([slug], change);
  }

  return (
    <div className="z-page">
      <div className="z-page-head">
        <p className="z-label">
          {batch.length === 0
            ? "Nothing yet"
            : newCount > 0
              ? `${newCount} new since your last visit`
              : `Top ${batch.length} of ${queue.length} in the queue`}
        </p>
        <h1 className="z-h1">Fresh talent, ranked.</h1>
      </div>

      {error && <div className="z-banner is-error">{error}</div>}

      {batch.length === 0 ? (
        <EmptyState
          title={loading ? "Loading." : "Nobody in the queue."}
          hint={
            loading ? undefined : (
              <>
                Run a sweep and add some people.{" "}
                <Link href="/sweep" className="z-linkish is-inline">
                  Go to sweep
                </Link>
              </>
            )
          }
        />
      ) : (
        <table
          role="presentation"
          cellPadding={0}
          cellSpacing={0}
          style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0 8px" }}
        >
          <tbody>
            {batch.map((c) => {
              const top = dominantSignals(c, 2);
              return (
                <tr key={c.slug}>
                  <td
                    style={{
                      background: "var(--z-surface)",
                      borderRadius: "var(--z-r-email)",
                      padding: "20px 24px",
                    }}
                  >
                    <table
                      role="presentation"
                      cellPadding={0}
                      cellSpacing={0}
                      style={{ width: "100%", borderCollapse: "collapse" }}
                    >
                      <tbody>
                        <tr>
                          <td style={{ verticalAlign: "top" }}>
                            <Link href={`/candidate/${c.slug}`} className="z-h4 z-person-name">
                              {c.name}
                            </Link>
                            {isNew(c.surfaced_at) && <span className="z-badge-new">new</span>}
                            <div
                              className="z-score"
                              data-thin={!c.enriched || undefined}
                              style={{ marginTop: 6 }}
                            >
                              <span className="z-score-sigma">
                                {formatSigma(c.score)}
                              </span>
                              <span className="z-score-class">{archetypeLabel(c.archetype)}</span>
                            </div>
                            {c.polymath && (
                              <div style={{ marginTop: 6 }}>
                                <PolymathBadge clusters={c.secondary_archetypes} />
                              </div>
                            )}
                          </td>

                          <td style={{ verticalAlign: "top", paddingLeft: 32, width: "46%" }}>
                            {top.length > 0 ? (
                              top.map((s) => (
                                <div
                                  key={s.id}
                                  className="z-small"
                                  style={{ color: "var(--z-ink-body)", marginBottom: 4 }}
                                >
                                  {s.label}{" "}
                                  <span className="z-num" style={{ color: "var(--z-ink-faint)" }}>
                                    {formatSigma(s.points)}
                                  </span>
                                </div>
                              ))
                            ) : (
                              <div className="z-small" style={{ color: "var(--z-ink-faint)" }}>
                                {c.enriched
                                  ? "Nothing in the taxonomy matched."
                                  : "Not enriched yet, so only the search text was read."}
                              </div>
                            )}
                          </td>

                          <td style={{ verticalAlign: "top", width: 120, textAlign: "right" }}>
                            <MarkControl slug={c.slug} mark={marks[c.slug]} onChange={rate} />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div
        className="z-row z-row-wrap"
        style={{ marginTop: "var(--z-space-10)", gap: "var(--z-space-5)" }}
      >
        <Link href="/queue" className="z-btn is-secondary is-sm">
          See the whole queue
        </Link>
        {/* Proof the tool is working: people it surfaced that you already rate.
            Folding this into "removed" would throw the signal away. */}
        {knownCount > 0 && (
          <Link href="/queue" className="z-small z-linkish">
            {knownCount} {knownCount === 1 ? "person" : "people"} you already knew
          </Link>
        )}
      </div>
    </div>
  );
}
