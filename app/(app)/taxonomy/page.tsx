"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { ARCHETYPES, archetypeLabel, type Archetype } from "@/lib/zscore";
import { DEFAULT_WEIGHT } from "@/lib/clusters";
import { COUNT_KINDS, type CountKind } from "@/lib/extract";
import type { TaxonomyPrefs } from "@/lib/state";
import {
  MAX_WEIGHT,
  TAG_FACETS,
  addAlias,
  clampWeight,
  indexRegistry,
  makeTag,
  normalizeKey,
  resolveAny,
  type TagDef,
  isTagFacet,
  type TagFacet,
  type TagRegistry,
} from "@/lib/tagRegistry";
import { heldTags, unmatchedTerms } from "@/lib/tags";
import { Button, Card, EmptyState, Pill } from "@/components/primitives";

/**
 * The taxonomy is the model.
 *
 * Every weight on this screen feeds the score directly, and the cluster column
 * decides which label a person carries — under highest-weight-wins, dragging RSI
 * above IOI genuinely reassigns every IOI+RSI person to Research. So the holder
 * count on each row matters: it says how many people a weight is about to move.
 *
 * ── What this screen is for ───────────────────────────────────────────────
 * Three jobs, in the order they are done: tune a weight, decide whether a tag
 * scores at all, and triage what the tagger found that the vocabulary does not
 * know yet. The layout follows that order and nothing else competes for the eye.
 *
 * It was a table in a narrow column, which put the on/off switch past the right
 * edge behind a horizontal scroll and left the weight slider about forty pixels
 * of travel. The list is now full width in its column, every section is open at
 * once, section headings stay put while their rows pass, and the weight can be
 * typed. What used to be a dozen underlined text buttons are shapes.
 *
 * "Unmatched, but notable" is fed by real terms read off real profiles. It needs
 * the LLM by construction — these are terms that are *not* in the taxonomy, so no
 * amount of string matching against the taxonomy can surface them.
 */

/** A term being promoted, with the suggestion to edit before it lands. */
type Promoting = {
  term: string;
  /**
   * Which section the new tag lands in, and it is a control rather than an
   * assumption. It was hardcoded to `award` with no way to change it, so
   * everything promoted from the review queue was filed as an award. Where the
   * finding came from a structured field the extractor already knows what it is
   * and that answer is pre-selected; where it came from prose, nothing does.
   */
  facet: TagFacet;
  weight: number;
  cluster: Archetype | null;
  why: string;
  asking: boolean;
};

/** Everything, or only the tags somebody actually holds. */
type Scope = "held" | "all";

export default function TaxonomyPage() {
  const { team, patchTeam, roster, loading, taggerEnabled, error, resetAll } = useApp();
  const t = team.taxonomy;

  const [confirmWipe, setConfirmWipe] = useState(false);
  const [promoting, setPromoting] = useState<Promoting | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTerm, setNewTerm] = useState("");
  const [query, setQuery] = useState("");
  const [facet, setFacet] = useState<TagFacet | "all">("all");
  /**
   * Held, until asked otherwise.
   *
   * The registry carries a few hundred seeded names and around a fifth of them
   * are on anybody. The other four fifths are vocabulary waiting for someone to
   * match it — real, worth keeping, and not what anyone opens this screen to
   * tune. Search still reaches them.
   */
  const [scope, setScope] = useState<Scope>("held");

  const people = useMemo(() => Object.values(roster), [roster]);

  /**
   * How many people hold each registry tag.
   *
   * `heldTags`, not the structured extractor alone. Counting only structured
   * output reported zero holders for every programme, award, college and high
   * school, because those are found by text matching and by the tagger — so RSI
   * scored on a profile while this screen said nobody had it.
   */
  const holders = useMemo(() => {
    const tally = new Map<string, number>();
    for (const p of people) {
      for (const { def } of heldTags(p, t)) tally.set(def.id, (tally.get(def.id) ?? 0) + 1);
    }
    return tally;
  }, [people, t]);

  /** A person's name, not their username. A slug is not who anybody is. */
  const nameOf = useCallback((slug: string) => roster[slug]?.name || slug, [roster]);

  const pending = useMemo(() => unmatchedTerms(people, t), [people, t]);

  const promotedCount = useMemo(
    () => Object.values(t.tags).filter((d) => d.promoted).length,
    [t.tags]
  );
  const heldCount = holders.size;

  /* ── Promote and dismiss ────────────────────────────────────────────────── */

  /**
   * Asking the model for a cluster and weight happens once per term, here, not
   * once per person. The answer is a starting point you edit before it lands.
   */
  async function beginPromote(term: string, known?: TagFacet) {
    setPromoting({
      term,
      facet: known ?? "program",
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
              // The model's guess never overrides a facet the extractor was
              // certain of; it only fills in for prose, where nothing else knows.
              facet: known ?? (isTagFacet(c?.facet) ? c.facet : prev.facet),
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
   * its own weight, cluster and aliases, so there is one row to edit and one
   * place a duplicate can be caught.
   */
  function commitPromote() {
    if (!promoting) return;
    const { term, weight, cluster, facet: f } = promoting;
    const def = makeTag({ label: term, facet: f, weight, cluster, promoted: true });

    // A label that already resolves is the same thing under another name, so it
    // becomes an alias rather than a second entry.
    const existing = resolveAny(indexRegistry(t.tags), term);
    const tags = existing ? addAlias(t.tags, existing.id, term) : { ...t.tags, [def.id]: def };

    patchTeam({ taxonomy: { ...t, tags } });
    setPromoting(null);
  }

  function dismiss(term: string) {
    patchTeam({ taxonomy: { ...t, dismissed: [...new Set([...t.dismissed, term])] } });
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

  return (
    <div className="z-page">
      <div className="z-page-head">
        {/* The two numbers this screen is about. The roster size was redundant —
            it is on the queue tab in the nav and it is not what is being tuned. */}
        <p className="z-label">
          {loading ? "Loading" : `${promotedCount} scoring, ${heldCount} held`}
        </p>
        <h1 className="z-h1">Taxonomy</h1>
      </div>

      {error && <div className="z-banner is-error">{error}</div>}

      <div
        className="z-taxonomy-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 340px",
          gap: "var(--z-space-8)",
          alignItems: "start",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="z-tools">
            <label className="z-search">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${Object.keys(t.tags).length} tags`}
                aria-label="Search tags"
              />
              {query && (
                <button
                  className="z-search-clear"
                  onClick={() => setQuery("")}
                  aria-label="Clear the search"
                >
                  ×
                </button>
              )}
            </label>

            {/* Two states, both visible. A single button cannot say which one is
                current and which one clicking it produces. */}
            <div className="z-segmented">
              <button
                className="z-segment"
                aria-pressed={scope === "held"}
                onClick={() => setScope("held")}
                title="Only tags at least one person holds"
              >
                Held
              </button>
              <button
                className="z-segment"
                aria-pressed={scope === "all"}
                onClick={() => setScope("all")}
                title="Every name in the vocabulary, held or not"
              >
                All
              </button>
            </div>

            {adding ? (
              <span className="z-row" style={{ gap: "var(--z-space-2)" }}>
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
                  style={{ width: 180, padding: "6px 10px", fontSize: "var(--z-fs-small)" }}
                />
                <button className="z-quiet is-accent" onClick={addByHand} disabled={!newTerm.trim()}>
                  Continue
                </button>
                <button
                  className="z-quiet is-bare"
                  onClick={() => {
                    setNewTerm("");
                    setAdding(false);
                  }}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button className="z-quiet" onClick={() => setAdding(true)}>
                + Add a tag
              </button>
            )}
          </div>

          <TagList
            registry={t.tags}
            holders={holders}
            query={query}
            facet={facet}
            scope={scope}
            loading={loading}
            onFacet={setFacet}
            onPatch={(tags) => patchTeam({ taxonomy: { ...t, tags } })}
          />
        </div>

        <div className="z-stack" style={{ gap: "var(--z-space-6)", minWidth: 0 }}>
          <div>
            <div className="z-col-head">
              <p className="z-label is-quiet">Unmatched, but notable</p>
            </div>
            <Card size="lg">
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
                <div>
                  {pending.slice(0, 12).map((p) => (
                    <div className="z-review-row" key={p.term}>
                      <span className="z-review-term">{p.term}</span>
                      <div className="z-review-foot">
                        <span className="z-review-seen">
                          {/* A real count over real people, each one reachable by
                              name, so a term can be checked before it is trusted.
                              This used to print their usernames. */}
                          <Link href={`/candidate/${p.slugs[0]}`}>{nameOf(p.slugs[0])}</Link>
                          {p.slugs.length > 1 && ` +${p.slugs.length - 1}`}
                        </span>
                        <button
                          className="z-quiet is-accent"
                          onClick={() => beginPromote(p.term, p.facet)}
                        >
                          Promote
                        </button>
                        <button className="z-quiet is-bare" onClick={() => dismiss(p.term)}>
                          Dismiss
                        </button>
                      </div>
                    </div>
                  ))}
                  {pending.length > 12 && (
                    <p className="z-micro" style={{ marginTop: "var(--z-space-3)" }}>
                      {pending.length - 12} more
                    </p>
                  )}
                </div>
              )}
            </Card>
          </div>

          <Rules taxonomy={t} onPatch={(next) => patchTeam({ taxonomy: { ...t, ...next } })} />

          {/* The corpus is minors, so a plain way to erase it is a requirement
              rather than a nicety. Weights survive: they are the team's tuning,
              not anybody's personal data. */}
          <details className="z-disclosure">
            <summary>Stored data</summary>
            <div className="z-disclosure-body z-stack" style={{ gap: "var(--z-space-4)" }}>
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
                  <button
                    className="z-quiet is-danger"
                    onClick={async () => {
                      await resetAll();
                      setConfirmWipe(false);
                    }}
                  >
                    Delete everything
                  </button>
                  <button className="z-quiet is-bare" onClick={() => setConfirmWipe(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="z-quiet"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() => setConfirmWipe(true)}
                  disabled={people.length === 0}
                >
                  Delete all stored people
                </button>
              )}

              {/**
               * Deleting from the Removed queue erases the person and blocks the
               * slug, so they cannot be found again by a sweep. That has to be
               * visible somewhere, or one misfire quietly removes someone from the
               * tool for good with no trace and no way back.
               */}
              {team.deleted.length > 0 && (
                <div className="z-stack" style={{ gap: "var(--z-space-2)" }}>
                  <p className="z-small">
                    {team.deleted.length}{" "}
                    {team.deleted.length === 1 ? "profile is" : "profiles are"} blocked from being
                    added again. Their stored data is already gone — unblocking only lets a sweep
                    surface them.
                  </p>
                  <div className="z-row z-row-wrap" style={{ gap: "var(--z-space-2)" }}>
                    {team.deleted.map((slug) => (
                      <span key={slug} className="z-custom-term">
                        <Pill>{slug}</Pill>
                        <button
                          className="z-custom-remove"
                          title={`Let ${slug} be found again`}
                          aria-label={`Unblock ${slug}`}
                          onClick={() =>
                            patchTeam({ deleted: team.deleted.filter((s) => s !== slug) })
                          }
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </details>

          {t.dismissed.length > 0 && (
            <details className="z-disclosure">
              <summary>
                Dismissed
                <span className="z-count">{t.dismissed.length}</span>
              </summary>
              <div
                className="z-disclosure-body z-row z-row-wrap"
                style={{ gap: "var(--z-space-2)" }}
              >
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

/* ── The tuning list ────────────────────────────────────────────────────── */

/**
 * Every section open at once, in one scroll.
 *
 * The accordion allowed one section at a time, which made comparing a company
 * weight against a programme weight impossible without two clicks and a memory —
 * and the two numbers being on one scale is the entire point of the model. The
 * facet rail narrows the same list rather than hiding the rest of it.
 */
function TagList({
  registry,
  holders,
  query,
  facet,
  scope,
  loading,
  onFacet,
  onPatch,
}: {
  registry: TagRegistry;
  holders: Map<string, number>;
  query: string;
  facet: TagFacet | "all";
  scope: Scope;
  /** Holders are counted from the roster, so before it arrives nothing is held. */
  loading: boolean;
  onFacet: (f: TagFacet | "all") => void;
  onPatch: (tags: TagRegistry) => void;
}) {
  const term = normalizeKey(query.trim()).replace(/-/g, " ");

  /** Sections, filtered and ordered. Held by the most people leads each one. */
  const sections = useMemo(() => {
    const searching = term.length > 0;
    const matches = (def: TagDef) => {
      if (searching) {
        const hay = [def.label, ...def.aliases].map((s) => normalizeKey(s).replace(/-/g, " "));
        return hay.some((h) => h.includes(term));
      }
      // A search reaches the whole vocabulary; browsing defaults to what is held.
      return scope === "all" || (holders.get(def.id) ?? 0) > 0;
    };

    const byFacet = new Map<TagFacet, TagDef[]>();
    for (const def of Object.values(registry)) {
      if (!matches(def)) continue;
      const list = byFacet.get(def.facet) ?? [];
      list.push(def);
      byFacet.set(def.facet, list);
    }
    /**
     * Heaviest first.
     *
     * It sorted by holder count, which put a 0.3 hackathon three people share above
     * the 2.0 accelerator one of them cleared — on a screen whose entire subject is
     * the ordering of weights. The number the list is about is the number it sorts on.
     */
    for (const list of byFacet.values()) {
      list.sort(
        (a, b) =>
          b.weight - a.weight ||
          (holders.get(b.id) ?? 0) - (holders.get(a.id) ?? 0) ||
          a.label.localeCompare(b.label)
      );
    }
    return TAG_FACETS.filter((f) => (byFacet.get(f) ?? []).length > 0).map((f) => ({
      facet: f,
      list: byFacet.get(f) ?? [],
    }));
  }, [registry, holders, term, scope]);

  const shown = facet === "all" ? sections : sections.filter((s) => s.facet === facet);
  const total = sections.reduce((n, s) => n + s.list.length, 0);

  const write = useCallback(
    (id: string, change: Partial<TagDef>) => {
      const def = registry[id];
      if (def) onPatch({ ...registry, [id]: { ...def, ...change } });
    },
    [registry, onPatch]
  );

  /**
   * Bulk switch, over the tags anyone holds.
   *
   * Never over the whole section: a click meaning "score every seeded company"
   * would switch on two hundred names nobody has matched, and undoing that is
   * two hundred clicks.
   */
  function switchAll(f: TagFacet, on: boolean) {
    const next = { ...registry };
    for (const def of sections.find((s) => s.facet === f)?.list ?? []) {
      if ((holders.get(def.id) ?? 0) > 0) next[def.id] = { ...def, promoted: on };
    }
    onPatch(next);
  }

  return (
    <>
      <div className="z-rail">
        <Pill as="button" active={facet === "all"} onClick={() => onFacet("all")}>
          All
          <span className="z-count">{total}</span>
        </Pill>
        {sections.map((s) => (
          <Pill
            key={s.facet}
            as="button"
            active={facet === s.facet}
            onClick={() => onFacet(s.facet)}
          >
            {FACET_LABEL[s.facet]}
            <span className="z-count">{s.list.length}</span>
          </Pill>
        ))}
      </div>

      {shown.length === 0 ? (
        /* Nothing during the load. "Nothing held yet" is true of an empty roster
           and false of one that has not arrived, and the two look identical. */
        loading ? (
          <div style={{ height: 200 }} />
        ) : (
          <EmptyState
            title={term ? "No tag by that name." : "Nothing held yet."}
            hint={
              term
                ? "Try fewer letters, or add it as a new tag."
                : "Switch to All to see the whole vocabulary."
            }
          />
        )
      ) : (
        <div className="z-tune">
          {shown.map(({ facet: f, list }) => {
            const held = list.filter((d) => (holders.get(d.id) ?? 0) > 0);
            return (
              <section className="z-tune-sec" key={f}>
                <div className="z-tune-head">
                  {/* Just the name. The count was printed on the facet capsule
                      directly above it, so the header was saying it twice. */}
                  <h2 className="z-tune-title">{FACET_LABEL[f]}</h2>
                  <span className="z-spacer" />
                  {held.length > 1 && (
                    <>
                      <button
                        className="z-quiet is-bare"
                        onClick={() => switchAll(f, true)}
                        title={`Score all ${held.length} held ${FACET_LABEL[f].toLowerCase()}`}
                      >
                        All on
                      </button>
                      <button
                        className="z-quiet is-bare"
                        onClick={() => switchAll(f, false)}
                        title={`Stop all ${held.length} held ${FACET_LABEL[f].toLowerCase()} scoring`}
                      >
                        All off
                      </button>
                    </>
                  )}
                </div>
                {list.map((def) => (
                  <TuneRow
                    key={def.id}
                    def={def}
                    people={holders.get(def.id) ?? 0}
                    onWrite={write}
                  />
                ))}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * One tag: what it is, what it is worth, how many it moves, whether it counts.
 *
 * The draft weight is local to the row rather than held in a map above it, so
 * dragging one slider re-renders one row instead of four hundred.
 */
function TuneRow({
  def,
  people,
  onWrite,
}: {
  def: TagDef;
  people: number;
  onWrite: (id: string, change: Partial<TagDef>) => void;
}) {
  /** Set while dragging. Writing per pixel would be a store write per pixel. */
  const [drag, setDrag] = useState<number | null>(null);
  /** Set while typing, so a half-finished "1." is not parsed as a weight. */
  const [typed, setTyped] = useState<string | null>(null);

  const weight = drag ?? def.weight;

  const commit = (v: number) => {
    const next = clampWeight(v);
    if (next !== def.weight) onWrite(def.id, { weight: next });
  };

  return (
    <div className="z-tune-row" data-idle={people === 0 || undefined}>
      <span className="z-tune-name-cell" style={{ minWidth: 0 }}>
        {/* The other spellings that resolve here live in the tooltip. As a second
            line under every name they were a hundred rows of grey subtext, which is
            most of what made this list heavy to look at. Search still matches them. */}
        <span
          className="z-tune-name"
          title={def.aliases.length > 0 ? `Also ${def.aliases.join(", ")}` : undefined}
        >
          {def.label}
        </span>

      </span>

      <span className="z-tune-range-cell">
        <input
          type="range"
          className="z-range"
          min={0}
          max={MAX_WEIGHT}
          step={0.1}
          value={weight}
          data-zero={weight === 0 || undefined}
          style={{ ["--fill" as string]: `${(weight / MAX_WEIGHT) * 100}%` }}
          onChange={(e) => setDrag(Number(e.target.value))}
          // Written on release rather than per pixel — and on key-up too, or the
          // arrow keys would move the handle and never save.
          onPointerUp={() => {
            if (drag !== null) commit(drag);
            setDrag(null);
          }}
          onKeyUp={() => {
            if (drag !== null) commit(drag);
            setDrag(null);
          }}
          onBlur={() => {
            if (drag !== null) commit(drag);
            setDrag(null);
          }}
          aria-label={`Weight for ${def.label}`}
        />
      </span>

      <input
        className="z-weight"
        type="number"
        min={0}
        max={MAX_WEIGHT}
        step={0.1}
        value={typed ?? weight.toFixed(1)}
        data-zero={weight === 0 || undefined}
        onChange={(e) => setTyped(e.target.value)}
        onBlur={() => {
          if (typed !== null) {
            const n = Number(typed);
            if (Number.isFinite(n)) commit(n);
            setTyped(null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setTyped(null);
            e.currentTarget.blur();
          }
        }}
        aria-label={`Weight for ${def.label}, as a number`}
      />

      <span className="z-tune-people">{people > 0 ? people : "—"}</span>

      <button
        type="button"
        className="z-switch"
        role="switch"
        aria-checked={def.promoted}
        aria-label={`${def.label} scores`}
        title={def.promoted ? "Scoring. Click to stop." : "Not scoring. Click to start."}
        onClick={() => onWrite(def.id, { promoted: !def.promoted })}
      />
    </div>
  );
}

/* ── Promote ────────────────────────────────────────────────────────────── */

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
    <div className="z-stack" style={{ gap: "var(--z-space-5)" }}>
      <div>
        <p className="z-h4" style={{ margin: 0 }}>
          {promoting.term}
        </p>
        <p className="z-micro" style={{ marginTop: 2 }}>
          {promoting.asking
            ? "Asking for a suggested cluster and weight."
            : promoting.why || "Set a section, a cluster and a weight, then add it."}
        </p>
      </div>

      {/* Grid, not a flex row: "Accelerators & funds" is the longest option in the
          first select and an even split truncated it. */}
      <div
        className="z-promote-selects"
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1fr",
          gap: "var(--z-space-2)",
        }}
      >
        <select
          className="z-input"
          value={promoting.facet}
          onChange={(e) => onChange({ ...promoting, facet: e.target.value as TagFacet })}
          style={{ padding: "6px 8px", fontSize: "var(--z-fs-small)" }}
          aria-label="Section"
        >
          {PROMOTABLE_FACETS.map((f) => (
            <option key={f} value={f}>
              {FACET_LABEL[f]}
            </option>
          ))}
        </select>
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
          aria-label="Cluster"
        >
          {ARCHETYPES.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
          <option value="none">No cluster</option>
        </select>
      </div>

      <div>
        <div className="z-row" style={{ gap: "var(--z-space-3)" }}>
          <input
            type="range"
            className="z-range"
            min={0}
            max={MAX_WEIGHT}
            step={0.1}
            value={promoting.weight}
            style={{ ["--fill" as string]: `${(promoting.weight / MAX_WEIGHT) * 100}%` }}
            onChange={(e) => onChange({ ...promoting, weight: Number(e.target.value) })}
            aria-label={`${promoting.term} weight`}
          />
          <input
            className="z-weight"
            type="number"
            min={0}
            max={MAX_WEIGHT}
            step={0.1}
            value={promoting.weight.toFixed(1)}
            onChange={(e) =>
              onChange({ ...promoting, weight: clampWeight(Number(e.target.value)) })
            }
            style={{ width: "3.25rem", flex: "none", borderColor: "var(--z-border)" }}
            aria-label={`${promoting.term} weight, as a number`}
          />
        </div>
        <p className="z-micro" style={{ marginTop: "var(--z-space-2)" }}>
          For scale, Y Combinator and IMO are 2.0, RSI is 1.6, ISEF is 0.7.
          {promoting.cluster
            ? ` Anyone whose top term is this becomes ${archetypeLabel(promoting.cluster)}.`
            : " No cluster means it scores but does not decide the label."}
        </p>
      </div>

      <div className="z-row" style={{ gap: "var(--z-space-3)" }}>
        <Button size="sm" onClick={onCommit} disabled={promoting.asking}>
          Add to taxonomy
        </Button>
        <button className="z-quiet is-bare" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * What a hand-promoted tag may become.
 *
 * Not every facet: a class year, a state and a count are derived facts with no
 * promote step, and offering them here would only be a way to make a mistake.
 */
const PROMOTABLE_FACETS: TagFacet[] = [
  "program",
  "accelerator",
  "startup",
  "lab",
  "club",
  "company",
  "org",
  "college",
  "highschool",
  "major",
  "title",
  "flag",
];

const FACET_LABEL: Record<TagFacet, string> = {
  program: "Programs & awards",
  accelerator: "Accelerators & funds",
  startup: "Startups",
  lab: "Research labs",
  club: "College clubs",
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

/* ── Scoring rules ──────────────────────────────────────────────────────── */

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
 * lib/clusters.ts, and the polymath rule was a sigma constant. On a sum, the
 * right value for each depends on how the weights were tuned, so they belong
 * next to them.
 */
function Rules({
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
        <p className="z-label is-quiet">Scoring rules</p>
      </div>
      <Card size="lg">
        {COUNT_KINDS.map((kind) => {
          const rule = taxonomy.counts[kind];
          return (
            <div className="z-rule-row" key={kind}>
              <span className="z-small" style={{ flex: 1, minWidth: 0 }}>
                {COUNT_LABEL[kind]}
              </span>
              <input
                className="z-stepper"
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
              />
              <span className="z-micro">up to</span>
              <input
                className="z-stepper"
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
              />
            </div>
          );
        })}

        <div className="z-rule-row">
          <span className="z-small" style={{ flex: 1, minWidth: 0 }}>
            Polymath, in two clusters
          </span>
          <input
            className="z-stepper"
            type="number"
            min={0}
            step={0.1}
            value={taxonomy.polymathPoints}
            onChange={(e) => onPatch({ polymathPoints: num(e.target.value, taxonomy.polymathPoints) })}
            aria-label="Polymath threshold"
          />
        </div>
      </Card>
    </div>
  );
}
