"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { PROGRAMS } from "@/lib/searchTaxonomy";
import { ARCHETYPES, archetypeLabel, type Archetype } from "@/lib/zscore";
import { DEFAULT_WEIGHT, START_WEIGHT, TERM_CLUSTER } from "@/lib/clusters";
import { termCounts, unmatchedTerms } from "@/lib/tags";
import { Button, Card, EmptyState, Pill } from "@/components/primitives";

/**
 * The taxonomy is the model.
 *
 * Every weight on this screen feeds the score directly, and the cluster column
 * decides which label a person carries — under highest-weight-wins, dragging RSI
 * above IOI genuinely reassigns every IOI+RSI person to Research. So the counts
 * on the right of each row matter: they say how many people a slider is about to
 * move.
 *
 * "Unmatched, but notable" is fed by real terms the tagger read off real
 * profiles. It needs the LLM by construction — these are terms that are *not* in
 * the taxonomy, so no amount of string matching against the taxonomy can surface
 * them.
 */

type Weighted = { label: string; weight: number; cluster: Archetype | null; count: number };

/** A term being promoted, with the suggestion to edit before it lands. */
type Promoting = {
  term: string;
  weight: number;
  cluster: Archetype | null;
  why: string;
  asking: boolean;
};

export default function TaxonomyPage() {
  const { team, patchTeam, roster, loading, taggerEnabled, error, resetAll } = useApp();
  const t = team.taxonomy;
  const [confirmWipe, setConfirmWipe] = useState(false);

  // Weight being dragged right now. Kept local so the slider stays smooth and a
  // drag does not fire a write per pixel.
  const [draft, setDraft] = useState<Record<string, number>>({});
  // Row order frozen while dragging. Without this a row jumps out from under the
  // cursor the moment its weight passes its neighbour.
  const [frozen, setFrozen] = useState<string[] | null>(null);
  const [promoting, setPromoting] = useState<Promoting | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTerm, setNewTerm] = useState("");

  const people = useMemo(() => Object.values(roster), [roster]);
  const counts = useMemo(() => termCounts(people, t), [people, t]);

  const weightOf = useCallback(
    (label: string) => draft[label] ?? t.weights[label] ?? START_WEIGHT[label] ?? DEFAULT_WEIGHT,
    [draft, t.weights]
  );

  const clusterFor = useCallback(
    (label: string): Archetype | null =>
      label in t.clusters ? t.clusters[label] : (TERM_CLUSTER[label] ?? null),
    [t.clusters]
  );

  const rows: Weighted[] = useMemo(() => {
    const built = [...new Set([...PROGRAMS, ...t.promoted])].map((label) => ({
      label,
      weight: weightOf(label),
      cluster: clusterFor(label),
      count: counts[label] ?? 0,
    }));

    if (frozen) {
      const rank = new Map(frozen.map((l, i) => [l, i]));
      return built.sort((a, b) => (rank.get(a.label) ?? 0) - (rank.get(b.label) ?? 0));
    }
    return built.sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));
  }, [t.promoted, weightOf, clusterFor, counts, frozen]);

  const pending = useMemo(() => unmatchedTerms(people, t), [people, t]);

  /* ── Weights ────────────────────────────────────────────────────────────── */

  function beginDrag() {
    if (!frozen) setFrozen(rows.map((r) => r.label));
  }

  /** Continuous while dragging: local only, no write, no reorder. */
  function dragWeight(label: string, weight: number) {
    beginDrag();
    setDraft((d) => ({ ...d, [label]: weight }));
  }

  /** On release: persist, then let the list re-sort. */
  function commitWeight(label: string) {
    const weight = draft[label];
    setFrozen(null);
    setDraft({});
    if (weight === undefined) return;
    if (weight === (t.weights[label] ?? START_WEIGHT[label] ?? DEFAULT_WEIGHT)) return;
    patchTeam({ taxonomy: { ...t, weights: { ...t.weights, [label]: weight } } });
  }

  function setCluster(label: string, value: string) {
    const cluster = value === "none" ? null : (value as Archetype);
    patchTeam({ taxonomy: { ...t, clusters: { ...t.clusters, [label]: cluster } } });
  }

  /* ── Promote and dismiss ────────────────────────────────────────────────── */

  /**
   * Asking the model for a cluster and weight happens once per term, here, not
   * once per person. The answer is a starting point you edit before it lands.
   */
  async function beginPromote(term: string) {
    setPromoting({ term, weight: DEFAULT_WEIGHT, cluster: null, why: "", asking: Boolean(taggerEnabled) });
    if (!taggerEnabled) return;

    try {
      const res = await fetch("/api/tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classify: term }),
      });
      const data = await res.json().catch(() => ({}));
      const c = data?.classification;
      setPromoting((prev) =>
        prev && prev.term === term
          ? {
              ...prev,
              asking: false,
              weight: typeof c?.weight === "number" ? c.weight : prev.weight,
              cluster: (c?.cluster ?? null) as Archetype | null,
              why: typeof c?.why === "string" ? c.why : "",
            }
          : prev
      );
    } catch {
      setPromoting((prev) => (prev && prev.term === term ? { ...prev, asking: false } : prev));
    }
  }

  function commitPromote() {
    if (!promoting) return;
    const { term, weight, cluster } = promoting;
    patchTeam({
      taxonomy: {
        ...t,
        promoted: [...new Set([...t.promoted, term])],
        weights: { ...t.weights, [term]: weight },
        clusters: { ...t.clusters, [term]: cluster },
      },
    });
    setPromoting(null);
  }

  function dismiss(term: string) {
    patchTeam({ taxonomy: { ...t, dismissed: [...new Set([...t.dismissed, term])] } });
  }

  /** Take a term back out of the taxonomy. It stops scoring immediately. */
  function unpromote(term: string) {
    const weights = { ...t.weights };
    const clusters = { ...t.clusters };
    delete weights[term];
    delete clusters[term];
    patchTeam({
      taxonomy: { ...t, promoted: t.promoted.filter((x) => x !== term), weights, clusters },
    });
  }

  function addByHand() {
    const term = newTerm.trim();
    setNewTerm("");
    setAdding(false);
    if (!term) return;
    const exists = [...PROGRAMS, ...t.promoted].some((x) => x.toLowerCase() === term.toLowerCase());
    if (exists) return;
    void beginPromote(term);
  }

  const dismissedCount = t.dismissed.length;

  return (
    <div className="z-page">
      <div className="z-page-head">
        <p className="z-label">
          {rows.length} terms weighted{people.length > 0 ? `, over ${people.length} people` : ""}
        </p>
        <h1 className="z-h1">Taxonomy</h1>
      </div>

      {error && <div className="z-banner is-error">{error}</div>}

      <div
        className="z-taxonomy-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)",
          gap: "var(--z-space-6)",
          alignItems: "start",
        }}
      >
        <div>
          <div className="z-col-head">
            <p className="z-label is-quiet">Term weights</p>
            <span className="z-spacer" />
            {loading && <span className="z-micro">Loading</span>}
            <button className="z-linkish" onClick={() => setAdding(true)}>
              Add a term
            </button>
          </div>

          {adding && (
            <div className="z-row" style={{ gap: "var(--z-space-2)", marginBottom: "var(--z-space-4)" }}>
              <input
                className="z-input"
                autoFocus
                placeholder="Davidson Fellow"
                value={newTerm}
                onChange={(e) => setNewTerm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addByHand();
                  if (e.key === "Escape") {
                    setNewTerm("");
                    setAdding(false);
                  }
                }}
                style={{ maxWidth: 280, padding: "6px 10px", fontSize: "var(--z-fs-small)" }}
              />
              <Button size="sm" onClick={addByHand} disabled={!newTerm.trim()}>
                Continue
              </Button>
              <button
                className="z-linkish"
                onClick={() => {
                  setNewTerm("");
                  setAdding(false);
                }}
              >
                Cancel
              </button>
            </div>
          )}

          <div className="z-table-wrap">
            <table className="z-table">
              <thead>
                <tr>
                  <th>Term</th>
                  <th style={{ width: 150 }}>Cluster</th>
                  <th style={{ width: 140 }}>Weight</th>
                  <th style={{ width: 48 }}>σ</th>
                  <th style={{ width: 70 }}>People</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isPromoted = t.promoted.includes(r.label);
                  return (
                    <tr key={r.label}>
                      <td style={{ fontWeight: 500, color: "var(--z-ink)" }}>
                        {r.label}
                        {isPromoted && (
                          <button
                            className="z-linkish z-quiet-action"
                            onClick={() => unpromote(r.label)}
                            title="Remove this term from the taxonomy"
                          >
                            remove
                          </button>
                        )}
                      </td>
                      <td>
                        <select
                          className="z-input"
                          style={{ padding: "6px 8px", fontSize: "var(--z-fs-micro)" }}
                          value={r.cluster ?? "none"}
                          onChange={(e) => setCluster(r.label, e.target.value)}
                          aria-label={`${r.label} cluster`}
                        >
                          {ARCHETYPES.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.label}
                            </option>
                          ))}
                          {/* Some credentials are real signal without implying a
                              talent type. QuestBridge is socioeconomic context,
                              not an archetype. */}
                          <option value="none">None</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="range"
                          min={0}
                          max={2}
                          step={0.1}
                          value={r.weight}
                          onChange={(e) => dragWeight(r.label, Number(e.target.value))}
                          onPointerDown={beginDrag}
                          onPointerUp={() => commitWeight(r.label)}
                          onKeyUp={() => commitWeight(r.label)}
                          onBlur={() => commitWeight(r.label)}
                          style={{ width: "100%", accentColor: "var(--z-blue)" }}
                          aria-label={`${r.label} weight`}
                        />
                      </td>
                      <td className="z-num" style={{ fontWeight: 600 }}>
                        {r.weight.toFixed(1)}
                      </td>
                      <td className="z-num">
                        {r.count > 0 ? (
                          <Link href={`/queue?archetype=${r.cluster ?? "all"}`} className="z-linkish">
                            {r.count}
                          </Link>
                        ) : (
                          <span style={{ color: "var(--z-ink-faint)" }}>0</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="z-stack" style={{ gap: "var(--z-space-6)" }}>
          <div>
            <div className="z-col-head">
              <p className="z-label is-quiet">Unmatched, but notable</p>
            </div>
            <Card size="lg">
              <p className="z-small" style={{ marginBottom: "var(--z-space-4)" }}>
                Terms the tagger read off profiles that are not in the taxonomy yet, so they carry no
                weight.
              </p>

              {promoting ? (
                <PromoteForm
                  promoting={promoting}
                  onChange={setPromoting}
                  onCommit={commitPromote}
                  onCancel={() => setPromoting(null)}
                />
              ) : taggerEnabled === false ? (
                <EmptyState
                  title="The tagger is off."
                  hint="Set ZSCORE_GROQ_API_KEY and new terms will start appearing here. Everything else works without it."
                />
              ) : pending.length === 0 ? (
                <EmptyState
                  title="All caught up."
                  hint={
                    people.length === 0
                      ? "Enrich some people and their credentials will show up here."
                      : "Nothing left to triage."
                  }
                />
              ) : (
                <div className="z-stack">
                  {pending.slice(0, 20).map((p) => (
                    <div className="z-row" key={p.term}>
                      <div style={{ minWidth: 0 }}>
                        <p className="z-small" style={{ color: "var(--z-ink)", fontWeight: 500 }}>
                          {p.term}
                        </p>
                        <p className="z-micro">
                          {/* A real count over real people, and each one is
                              reachable, so a term can be checked before it is
                              trusted. */}
                          seen on {p.count} {p.count === 1 ? "profile" : "profiles"}
                          {p.slugs.slice(0, 3).map((slug) => (
                            <span key={slug}>
                              {" "}
                              <Link href={`/candidate/${slug}`} className="z-linkish">
                                {slug}
                              </Link>
                            </span>
                          ))}
                        </p>
                      </div>
                      <span className="z-spacer" />
                      <Pill as="button" onClick={() => beginPromote(p.term)}>
                        promote
                      </Pill>
                      <button className="z-linkish" onClick={() => dismiss(p.term)}>
                        dismiss
                      </button>
                    </div>
                  ))}
                  {pending.length > 20 && (
                    <p className="z-micro">
                      {pending.length - 20} more below the top 20, ranked by how many profiles carry
                      them.
                    </p>
                  )}
                </div>
              )}
            </Card>
          </div>

          {/* The corpus is minors, so a plain way to erase it is a requirement
              rather than a nicety. Weights survive: they are the team's tuning,
              not anybody's personal data. */}
          <details className="z-disclosure">
            <summary>Stored data</summary>
            <div className="z-disclosure-body z-stack" style={{ gap: "var(--z-space-3)" }}>
              <p className="z-small">
                {people.length === 0
                  ? "No people are stored."
                  : `${people.length} ${people.length === 1 ? "person is" : "people are"} stored, shared across the team.`}
              </p>
              {confirmWipe ? (
                <div className="z-row z-row-wrap" style={{ gap: "var(--z-space-3)" }}>
                  <span className="z-small" style={{ color: "var(--z-ink)" }}>
                    Delete all {people.length}? This cannot be undone.
                  </span>
                  <Button
                    size="sm"
                    onClick={async () => {
                      await resetAll();
                      setConfirmWipe(false);
                    }}
                  >
                    Delete everything
                  </Button>
                  <button className="z-linkish" onClick={() => setConfirmWipe(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="z-linkish"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() => setConfirmWipe(true)}
                  disabled={people.length === 0}
                >
                  Delete all stored people
                </button>
              )}
            </div>
          </details>

          {dismissedCount > 0 && (
            <details className="z-disclosure">
              <summary>
                Dismissed
                <span className="z-count">{dismissedCount}</span>
              </summary>
              <div className="z-disclosure-body z-row z-row-wrap" style={{ gap: "var(--z-space-2)" }}>
                {t.dismissed.map((term) => (
                  <span key={term} className="z-custom-term">
                    <Pill>{term}</Pill>
                    <button
                      className="z-custom-remove"
                      title={`Bring ${term} back to the review queue`}
                      aria-label={`Bring ${term} back`}
                      onClick={() =>
                        patchTeam({
                          taxonomy: { ...t, dismissed: t.dismissed.filter((x) => x !== term) },
                        })
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function PromoteForm({
  promoting,
  onChange,
  onCommit,
  onCancel,
}: {
  promoting: Promoting;
  onChange: (p: Promoting) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="z-stack" style={{ gap: "var(--z-space-4)" }}>
      <div>
        <p className="z-h4">{promoting.term}</p>
        <p className="z-micro">
          {promoting.asking
            ? "Asking for a suggested cluster and weight."
            : promoting.why || "Set a cluster and a weight, then add it."}
        </p>
      </div>

      <div>
        <p className="z-label is-quiet" style={{ marginBottom: "var(--z-space-2)" }}>
          Cluster
        </p>
        <select
          className="z-input"
          value={promoting.cluster ?? "none"}
          onChange={(e) =>
            onChange({
              ...promoting,
              cluster: e.target.value === "none" ? null : (e.target.value as Archetype),
            })
          }
          style={{ padding: "6px 8px", fontSize: "var(--z-fs-small)" }}
        >
          {ARCHETYPES.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
          <option value="none">None</option>
        </select>
      </div>

      <div>
        <p className="z-label is-quiet" style={{ marginBottom: "var(--z-space-2)" }}>
          Weight <span className="z-num">{promoting.weight.toFixed(1)}</span>
        </p>
        <input
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={promoting.weight}
          onChange={(e) => onChange({ ...promoting, weight: Number(e.target.value) })}
          style={{ width: "100%", accentColor: "var(--z-blue)" }}
          aria-label={`${promoting.term} weight`}
        />
        <p className="z-micro">
          For scale, IMO is 2.0 and TASP is 0.6.
          {promoting.cluster
            ? ` Anyone whose top term is this becomes ${archetypeLabel(promoting.cluster)}.`
            : " No cluster means it scores but does not decide the label."}
        </p>
      </div>

      <div className="z-row">
        <Button size="sm" onClick={onCommit} disabled={promoting.asking}>
          Add to taxonomy
        </Button>
        <button className="z-linkish" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
