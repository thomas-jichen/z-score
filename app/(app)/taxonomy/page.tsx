"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { ARCHETYPES, archetypeLabel, type Archetype } from "@/lib/zscore";
import { DEFAULT_WEIGHT, START_WEIGHT, TERM_CLUSTER } from "@/lib/clusters";
import { COUNT_KINDS, extractTags, type CountKind } from "@/lib/extract";
import type { TaxonomyPrefs } from "@/lib/state";
import {
  MAX_WEIGHT,
  TAG_FACETS,
  addAlias,
  indexRegistry,
  makeTag,
  resolveAny,
  resolveTag,
  type TagDef,
  type TagFacet,
  type TagRegistry,
} from "@/lib/tagRegistry";
import { heldTags, termCounts, unmatchedTerms } from "@/lib/tags";
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

/** A term being promoted, with the suggestion to edit before it lands. */
type Promoting = {
  term: string;
  /** Which facet the new tag belongs to. Prose findings are awards by default. */
  facet: TagFacet;
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

  /**
   * How many people hold each registry tag.
   *
   * The same number the legacy table shows for a term, and it matters for the same
   * reason: a weight slider is about to move everyone counted here, and promoting
   * a tag nobody holds is wasted effort. Counted over the whole roster in one pass.
   */
  const tagHolders = useMemo(() => {
    const tally = new Map<string, number>();
    for (const p of people) {
      // `heldTags`, not the structured extractor alone. Counting only structured
      // output reported zero holders for every programme, award, college and high
      // school, because those are found by text matching and by the tagger — so
      // RSI scored +1.8σ on a profile while this screen said nobody had it.
      for (const { def } of heldTags(p, t)) {
        tally.set(def.id, (tally.get(def.id) ?? 0) + 1);
      }
    }
    return tally;
  }, [people, t]);

  const weightOf = useCallback(
    (label: string) => draft[label] ?? t.weights[label] ?? START_WEIGHT[label] ?? DEFAULT_WEIGHT,
    [draft, t.weights]
  );

  const clusterFor = useCallback(
    (label: string): Archetype | null =>
      label in t.clusters ? t.clusters[label] : (TERM_CLUSTER[label] ?? null),
    [t.clusters]
  );

  const pending = useMemo(() => unmatchedTerms(people, t), [people, t]);

  /* ── Promote and dismiss ────────────────────────────────────────────────── */

  /**
   * Asking the model for a cluster and weight happens once per term, here, not
   * once per person. The answer is a starting point you edit before it lands.
   */
  async function beginPromote(term: string) {
    setPromoting({
      term,
      // The review queue is fed by the tagger reading prose, and what it finds
      // there is a credential. Editable before it lands.
      facet: "award",
      weight: DEFAULT_WEIGHT,
      cluster: null,
      why: "",
      asking: Boolean(taggerEnabled),
    });
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

  /**
   * Promoting writes one registry entry.
   *
   * It used to write three parallel structures — `promoted`, `weights` and
   * `clusters`, all keyed by the raw string — which is what allowed two spellings
   * of one award to exist with two independent weights. A registry entry carries
   * its own weight, cluster and aliases, so there is one row to edit and one place
   * a duplicate can be caught.
   */
  function commitPromote() {
    if (!promoting) return;
    const { term, weight, cluster, facet } = promoting;
    const def = makeTag({ label: term, facet, weight, cluster, promoted: true });

    // A label that already resolves is the same thing under another name, so it
    // becomes an alias rather than a second entry.
    const existing = resolveAny(indexRegistry(t.tags), term);
    const tags = existing
      ? addAlias(t.tags, existing.id, term)
      : { ...t.tags, [def.id]: def };

    patchTeam({ taxonomy: { ...t, tags } });
    setPromoting(null);
  }

  function dismiss(term: string) {
    patchTeam({ taxonomy: { ...t, dismissed: [...new Set([...t.dismissed, term])] } });
  }

  /** Stop a tag scoring. The entry stays, so its aliases are not lost. */
  function unpromote(term: string) {
    const def = resolveAny(indexRegistry(t.tags), term);
    if (!def) return;
    patchTeam({ taxonomy: { ...t, tags: { ...t.tags, [def.id]: { ...def, promoted: false } } } });
  }

  function addByHand() {
    const term = newTerm.trim();
    setNewTerm("");
    setAdding(false);
    if (!term) return;
    // Normalised, so "Coca-Cola Scholarship Recipient" is recognised as the
    // Coca-Cola Scholar tag that already exists rather than added again.
    if (resolveAny(indexRegistry(t.tags), term)) return;
    void beginPromote(term);
  }

  const dismissedCount = t.dismissed.length;

  return (
    <div className="z-page">
      <div className="z-page-head">
        <p className="z-label">
          {Object.values(t.tags).filter((d) => d.promoted).length} tags scoring
          {people.length > 0 ? `, over ${people.length} people` : ""}
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
            <p className="z-label is-quiet">Tag weights</p>
            <span className="z-spacer" />
            {loading && <span className="z-micro">Loading</span>}
            <button className="z-linkish" onClick={() => setAdding(true)}>
              Add a tag
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
          <TagRegistryEditor
            registry={t.tags}
            holders={tagHolders}
            onPatch={(tags) => patchTeam({ taxonomy: { ...t, tags } })}
          />
        </div>

        <div className="z-stack" style={{ gap: "var(--z-space-6)" }}>
          <Calibration taxonomy={t} onPatch={(next) => patchTeam({ taxonomy: { ...t, ...next } })} />
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

/* ── The tag registry ───────────────────────────────────────────────────── */

/**
 * One row per real-world thing, grouped by facet.
 *
 * This is where the bulk of a modern score is tuned. The table above it covers
 * the older text-matched programme vocabulary; everything read off a structured
 * field — companies, schools, majors, titles, flags — lives here.
 *
 * Nothing scores until its switch is on. That gate is deliberate, and the
 * bulk control is what keeps it usable: promoting thirty companies one at a time
 * would be the reason to abandon the gate rather than a reason to keep it.
 */
function TagRegistryEditor({
  registry,
  holders,
  onPatch,
}: {
  registry: TagRegistry;
  holders: Map<string, number>;
  onPatch: (tags: TagRegistry) => void;
}) {
  const [open, setOpen] = useState<TagFacet | null>("company");
  const [draft, setDraft] = useState<Record<string, number>>({});

  const byFacet = useMemo(() => {
    const m = new Map<TagFacet, TagDef[]>();
    for (const def of Object.values(registry)) {
      const list = m.get(def.facet) ?? [];
      list.push(def);
      m.set(def.facet, list);
    }
    // Held by the most people first: those are the sliders that move the most.
    for (const list of m.values()) {
      list.sort(
        (a, b) =>
          (holders.get(b.id) ?? 0) - (holders.get(a.id) ?? 0) ||
          b.weight - a.weight ||
          a.label.localeCompare(b.label)
      );
    }
    return m;
  }, [registry, holders]);

  function write(id: string, change: Partial<TagDef>) {
    const def = registry[id];
    if (!def) return;
    onPatch({ ...registry, [id]: { ...def, ...change } });
  }

  function promoteFacet(facet: TagFacet, on: boolean) {
    const next = { ...registry };
    for (const def of byFacet.get(facet) ?? []) {
      // Only tags anyone actually holds, so a bulk click does not switch on
      // hundreds of seeded entries nobody has matched yet.
      if ((holders.get(def.id) ?? 0) > 0) next[def.id] = { ...def, promoted: on };
    }
    onPatch(next);
  }

  return (
    <div>
      <p className="z-small" style={{ marginBottom: "var(--z-space-4)", maxWidth: "62ch" }}>
        Everything the score is made of. Most are read straight off structured profile fields, so
        they are exact rather than inferred, and each one scores only once it is switched on.
        <span className="z-micro" style={{ display: "block", marginTop: "var(--z-space-2)" }}>
          {Object.keys(registry).length} in the registry. These are also the options the sweep
          menus offer.
        </span>
      </p>

      <div className="z-stack" style={{ gap: "var(--z-space-3)" }}>
        {TAG_FACETS.map((facet) => {
          const list = byFacet.get(facet) ?? [];
          if (list.length === 0) return null;
          const held = list.filter((d) => (holders.get(d.id) ?? 0) > 0);
          const on = held.filter((d) => d.promoted).length;
          const isOpen = open === facet;

          return (
            <div key={facet} className="z-disclosure">
              <summary
                style={{
                  listStyle: "none",
                  cursor: "pointer",
                  padding: "var(--z-space-3) var(--z-space-5)",
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--z-space-3)",
                  fontSize: "var(--z-fs-small)",
                }}
                onClick={() => setOpen(isOpen ? null : facet)}
              >
                {FACET_LABEL[facet]}
                <span className="z-count">
                  {held.length > 0 ? `${on} of ${held.length} on` : `${list.length}`}
                </span>
              </summary>

              {isOpen && (
                <div className="z-disclosure-body">
                  {held.length > 1 && (
                    <div className="z-row" style={{ marginBottom: "var(--z-space-4)" }}>
                      <button className="z-linkish" onClick={() => promoteFacet(facet, true)}>
                        Switch on all {held.length} held
                      </button>
                      <button className="z-linkish" onClick={() => promoteFacet(facet, false)}>
                        Switch all off
                      </button>
                    </div>
                  )}

                  {list.length === 0 ? (
                    <p className="z-small">Nothing here yet.</p>
                  ) : (
                    <div className="z-table-wrap">
                      <table className="z-table">
                        <thead>
                          <tr>
                            <th>Tag</th>
                            <th style={{ width: 140 }}>Weight</th>
                            <th style={{ width: 48 }}>σ</th>
                            <th style={{ width: 70 }}>People</th>
                            <th style={{ width: 60 }}>Scores</th>
                          </tr>
                        </thead>
                        <tbody>
                          {list.slice(0, 60).map((def) => {
                            const n = holders.get(def.id) ?? 0;
                            const weight = draft[def.id] ?? def.weight;
                            return (
                              <tr key={def.id} data-dimmed={n === 0 || undefined}>
                                <td>
                                  <span className="z-person-name" style={{ fontWeight: 500 }}>
                                    {def.label}
                                  </span>
                                  {def.aliases.length > 0 && (
                                    <span className="z-person-sub">
                                      also {def.aliases.slice(0, 3).join(", ")}
                                    </span>
                                  )}
                                </td>
                                <td>
                                  <input
                                    type="range"
                                    min={0}
                                    max={MAX_WEIGHT}
                                    step={0.1}
                                    value={weight}
                                    onChange={(e) =>
                                      setDraft((d) => ({ ...d, [def.id]: Number(e.target.value) }))
                                    }
                                    // Same reason as the table above: write on
                                    // release, not per pixel.
                                    onPointerUp={() => {
                                      setDraft((d) => {
                                        const { [def.id]: v, ...rest } = d;
                                        if (v !== undefined && v !== def.weight) {
                                          write(def.id, { weight: v });
                                        }
                                        return rest;
                                      });
                                    }}
                                    style={{ width: "100%", accentColor: "var(--z-blue)" }}
                                    aria-label={`Weight for ${def.label}`}
                                  />
                                </td>
                                <td className="z-num">{weight.toFixed(1)}</td>
                                <td className="z-num">{n}</td>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={def.promoted}
                                    onChange={(e) => write(def.id, { promoted: e.target.checked })}
                                    aria-label={`${def.label} scores`}
                                    style={{ accentColor: "var(--z-blue)", width: 15, height: 15 }}
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {list.length > 60 && (
                        <p className="z-micro" style={{ padding: "var(--z-space-3)" }}>
                          {list.length} tags, showing the 60 held by the most people.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const FACET_LABEL: Record<TagFacet, string> = {
  program: "Programs",
  award: "Awards",
  company: "Companies",
  org: "Organisations",
  college: "Colleges",
  highschool: "High schools",
  major: "Majors",
  title: "Titles",
  flag: "Flags",
  count: "Counts",
  year: "Class years",
  state: "Current state",
  homestate: "Home state",
};

/* ── Calibration ────────────────────────────────────────────────────────── */

const COUNT_LABEL: Record<CountKind, string> = {
  experience: "Each experience",
  project: "Each project",
  publication: "Each publication",
  patent: "Each patent",
  honor: "Each honor",
};

/**
 * Everything the score depends on that is not a tag weight.
 *
 * These used to be constants in three different files: the count bonuses were
 * hardcoded in lib/candidates.ts, the band cutoffs were sigma thresholds in
 * lib/clusters.ts, and the polymath rule was a sigma constant. On a sum, the right
 * value for each depends on how the weights were tuned, so they belong next to them.
 */
function Calibration({
  taxonomy,
  onPatch,
}: {
  taxonomy: TaxonomyPrefs;
  onPatch: (next: Partial<TaxonomyPrefs>) => void;
}) {
  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return (
    <div>
      <div className="z-col-head">
        <p className="z-label is-quiet">Calibration</p>
      </div>
      <Card size="lg">
        <p className="z-small" style={{ marginBottom: "var(--z-space-5)" }}>
          The score is the sum of every tag switched on, plus the counts below. Nothing else.
        </p>

        <p className="z-label is-quiet">Counts</p>
        {COUNT_KINDS.map((kind) => {
          const rule = taxonomy.counts[kind];
          return (
            <div className="z-breakdown-row" key={kind}>
              <span className="z-small">{COUNT_LABEL[kind]}</span>
              <span className="z-row" style={{ gap: "var(--z-space-2)" }}>
                <input
                  className="z-input"
                  type="number"
                  min={0}
                  max={MAX_WEIGHT}
                  step={0.1}
                  value={rule.points}
                  onChange={(e) =>
                    onPatch({
                      counts: {
                        ...taxonomy.counts,
                        [kind]: { ...rule, points: num(e.target.value, rule.points) },
                      },
                    })
                  }
                  aria-label={`Points per ${kind}`}
                  style={{ width: 68, padding: "4px 6px", fontSize: "var(--z-fs-micro)" }}
                />
                <span className="z-micro">up to</span>
                <input
                  className="z-input"
                  type="number"
                  min={1}
                  max={50}
                  step={1}
                  value={rule.cap}
                  onChange={(e) =>
                    onPatch({
                      counts: {
                        ...taxonomy.counts,
                        [kind]: { ...rule, cap: Math.round(num(e.target.value, rule.cap)) },
                      },
                    })
                  }
                  aria-label={`Cap for ${kind}`}
                  style={{ width: 60, padding: "4px 6px", fontSize: "var(--z-fs-micro)" }}
                />
              </span>
            </div>
          );
        })}
        <p className="z-micro" style={{ marginTop: "var(--z-space-3)" }}>
          The cap is what stops a padded profile out-scoring a strong one. Set the points to zero to
          stop counting a category entirely.
        </p>

        <p className="z-label is-quiet" style={{ marginTop: "var(--z-space-6)" }}>
          Colour bands
        </p>
        {(["exceptional", "strong", "above", "mid"] as const).map((band) => (
          <div className="z-breakdown-row" key={band}>
            <span className="z-small" style={{ textTransform: "capitalize" }}>
              {band}
            </span>
            <input
              className="z-input"
              type="number"
              min={0}
              step={0.5}
              value={taxonomy.bands[band]}
              onChange={(e) =>
                onPatch({
                  bands: { ...taxonomy.bands, [band]: num(e.target.value, taxonomy.bands[band]) },
                })
              }
              aria-label={`${band} threshold`}
              style={{ width: 74, padding: "4px 6px", fontSize: "var(--z-fs-micro)" }}
            />
          </div>
        ))}

        <div className="z-breakdown-row" style={{ marginTop: "var(--z-space-5)" }}>
          <span className="z-small">Polymath, points in two clusters</span>
          <input
            className="z-input"
            type="number"
            min={0}
            step={0.1}
            value={taxonomy.polymathPoints}
            onChange={(e) =>
              onPatch({ polymathPoints: num(e.target.value, taxonomy.polymathPoints) })
            }
            aria-label="Polymath threshold"
            style={{ width: 74, padding: "4px 6px", fontSize: "var(--z-fs-micro)" }}
          />
        </div>
      </Card>
    </div>
  );
}
