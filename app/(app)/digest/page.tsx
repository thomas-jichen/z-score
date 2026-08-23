"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/components/AppState";
import { archetypeLabel, dominantSignals, formatSigma } from "@/lib/zscore";
import { EmptyState, MarkControl, Pill, PolymathBadge, type MarkChange } from "@/components/primitives";

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
                    {/* A table because this layout is also the email. `z-digest-card`
                        is what lets the cells stack on a phone, where three fixed
                        columns became 130px each and broke every name in half. */}
                    <table
                      role="presentation"
                      className="z-digest-card"
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

      <Delivery />
    </div>
  );
}

/* ── Delivery ───────────────────────────────────────────────────────────── */

/**
 * The same page, in an inbox.
 *
 * It lived on the Agent screen as one disclosure among six, which was the wrong
 * room: the Agent screen is where you configure a machine that spends money, and
 * this is a preference about a page you are already looking at. Here the setting is
 * next to the thing it delivers, so "every day" has an obvious referent.
 *
 * ── Why it is not a disclosure ────────────────────────────────────────────
 * A lone <details> at the foot of a page with no other disclosures reads as a widget
 * somebody bolted on. The state is one sentence, so the sentence is the interface:
 * it says what will happen in plain words, and the controls sit beside it. Nothing
 * to open, nothing to discover.
 *
 * ── The address comes first ───────────────────────────────────────────────
 * No cadence until there is somewhere to send it. Asking how often before asking
 * where is the shape that produces settings screens full of controls that do
 * nothing, and a disabled row of pills is a worse answer than no row at all.
 */
function Delivery() {
  const { state, patch } = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const address = state.email;
  const open = editing || !address;

  /**
   * Saved on the way out rather than on every keystroke. Half an address written to
   * Redis on the way to a whole one is a write that means nothing, and the app would
   * briefly believe it.
   */
  function save() {
    const next = draft.trim();
    setEditing(false);
    if (next === (address ?? "")) return;
    patch({ email: next || null });
    setSaid(next ? null : "Address cleared, so nothing will be sent.");
  }

  async function test() {
    setBusy(true);
    setSaid(null);
    try {
      const r = await fetch("/api/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "test" }),
      }).then((x) => x.json());
      setSaid(r.ok ? `Sent. Subject: ${r.subject}` : r.error);
    } catch {
      setSaid("Could not reach the server.");
    }
    setBusy(false);
  }

  /**
   * One sentence for every combination, because a person should be able to read the
   * setting rather than assemble it from three controls. "Nothing is being sent" is
   * a real state and worth saying out loud: an address with no cadence and no
   * campaign report is the quiet way to end up wondering why no mail arrives.
   */
  const every = state.digest === "daily" ? "Every day" : state.digest === "weekly" ? "Every week" : null;
  const sentence = !address
    ? "This page can come to you."
    : every
      ? `${every} to ${address}.`
      : state.campaignEmails
        ? `When a campaign finishes, to ${address}.`
        : `Nothing is being sent to ${address}.`;

  return (
    <section className="z-delivery">
      <p className="z-label">Delivery</p>
      <div className="z-delivery-row">
        <div className="z-delivery-say">
          <p className="z-delivery-line">{sentence}</p>

          {open ? (
            <div className="z-row z-row-wrap" style={{ gap: "var(--z-space-3)", marginTop: 8 }}>
              <input
                className="z-set-input z-delivery-input"
                type="email"
                inputMode="email"
                autoFocus={editing}
                placeholder="you@example.com"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={save}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setEditing(false);
                }}
                aria-label="Your address"
              />
              <span className="z-micro">Yours alone, and nobody else sees it.</span>
            </div>
          ) : (
            <div className="z-row z-row-wrap" style={{ gap: "var(--z-space-4)", marginTop: 8 }}>
              <button
                className="z-linkish"
                onClick={() => {
                  setDraft(address ?? "");
                  setSaid(null);
                  setEditing(true);
                }}
              >
                Change address
              </button>
              <button className="z-quiet is-accent" onClick={test} disabled={busy}>
                {busy ? "Sending" : "Send me one now"}
              </button>
              {said && <span className="z-micro">{said}</span>}
            </div>
          )}
        </div>

        {address && !editing && (
          <div className="z-delivery-set">
            <div className="z-row z-row-wrap" style={{ gap: "var(--z-space-2)" }}>
              {(["off", "daily", "weekly"] as const).map((c) => (
                <Pill
                  key={c}
                  as="button"
                  active={state.digest === c}
                  onClick={() => patch({ digest: c })}
                  title={
                    c === "off"
                      ? "No scheduled digest. A campaign finishing can still reach you."
                      : `The top of your queue, ${c}.`
                  }
                >
                  {c === "off" ? "No digest" : c === "daily" ? "Every day" : "Every week"}
                </Pill>
              ))}
            </div>
            <Pill
              as="button"
              active={state.campaignEmails}
              onClick={() => patch({ campaignEmails: !state.campaignEmails })}
              title="A report when one of your campaigns finishes."
            >
              When a campaign finishes
            </Pill>
          </div>
        )}
      </div>
    </section>
  );
}
