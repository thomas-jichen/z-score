"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useApp } from "@/components/AppState";
import { estimateCost, formatCost } from "@/lib/enrichment";
import { emptyFilters, type QueueFilters } from "@/lib/state";
import type { PersonStatus } from "@/lib/people";
import {
  ARCHETYPES,
  archetypeLabel,
  formatSigma,
  type Archetype,
  type Candidate,
} from "@/lib/zscore";
import {
  ArchetypeTag,
  Button,
  DeviationBar,
  EmptyState,
  MarkControl,
  PersonCell,
  Pill,
  PolymathBadge,
  ZScoreBadge,
  type MarkChange,
} from "@/components/primitives";

const YEARS = ["2026", "2027", "2028", "2029", "2030", "2031", "2032", "2033"];

/**
 * Enriched, not enriched, or both.
 *
 * "Not enriched" is the half that was missing and the half that does work: a
 * search result carries a name, a headline and almost no score, and the way it
 * becomes a candidate is that somebody pulls the profile. Filtering to exactly
 * those people, ticking the header checkbox and pressing the button the bulk bar
 * is already offering is the whole loop, in three clicks.
 */
const ENRICHMENT_OPTIONS: { id: QueueFilters["enrichment"]; label: string; hint?: string }[] = [
  { id: "all", label: "All" },
  { id: "enriched", label: "Enriched", hint: "Profile pulled, so honours and experience count" },
  { id: "thin", label: "Not enriched", hint: "Search result only, nothing pulled yet" },
];

type View = "queued" | "known" | "rejected";
type Sort = "score" | "recent";

function QueueInner() {
  const params = useSearchParams();
  const {
    loading,
    roster,
    marks,
    team,
    candidates,
    state,
    patch,
    mark,
    setCluster,
    enrich,
    analyze,
    analyzing,
    taggerEnabled,
    removePeople,
    job,
    error,
    ephemeral,
  } = useApp();

  const [view, setView] = useState<View>("queued");
  const [sort, setSort] = useState<Sort>("score");
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<QueueFilters>(emptyFilters);
  const [restored, setRestored] = useState(false);
  const [undo, setUndo] = useState<{ slugs: string[]; status: PersonStatus; label: string } | null>(
    null
  );
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Who is one click from being erased.
   *
   * Deleting is the only control on this screen with no undo, so it asks first — and
   * it asks in the banner rather than on the row. There is no room beside a 2rem
   * button to say what deleting actually does, and "delete?" next to a name is not
   * the same warning as "this erases their stored profile and blocks them from
   * sweeps". Same slot the undo banner uses, which is where this screen already puts
   * a decision that has to be read.
   */
  const [pendingDelete, setPendingDelete] = useState<{ slugs: string[]; label: string } | null>(
    null
  );

  // Deep link from an archetype tag anywhere in the app.
  const linked = params.get("archetype");

  // Restore the saved filters once, then persist every change. The field existed
  // in stored state and was never read until now.
  useEffect(() => {
    if (loading || restored) return;
    const stored = state.queueFilters;
    setFilters({
      ...(stored ?? emptyFilters()),
      ...(linked && ARCHETYPES.some((a) => a.id === linked)
        ? { cluster: linked as Archetype }
        : {}),
    });
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, restored]);

  const setFilter = useCallback(
    (change: Partial<QueueFilters>) => {
      setFilters((prev) => {
        const next = { ...prev, ...change };
        patch({ queueFilters: next });
        return next;
      });
    },
    [patch]
  );

  /**
   * Score filter options, built from the taxonomy rather than hardcoded.
   *
   * The thresholds used to be sigma constants baked into `scoreBand`, so the
   * labels read "≥ +2.5σ" forever regardless of how the weights were tuned. Now a
   * weight edit moves both the bands and the labels together.
   */
  const bands = team.taxonomy.bands;
  const bandFloor: Record<string, number> = useMemo(
    () => ({
      exceptional: bands.exceptional,
      strong: bands.strong,
      above: bands.above,
      mid: bands.mid,
    }),
    [bands]
  );
  const bandOptions = useMemo(
    () => [
      { id: "all", label: "All" },
      { id: "exceptional", label: `≥ ${formatSigma(bands.exceptional)}` },
      { id: "strong", label: `≥ ${formatSigma(bands.strong)}` },
      { id: "above", label: `≥ ${formatSigma(bands.above)}` },
      { id: "mid", label: `≥ ${formatSigma(bands.mid)}` },
    ],
    [bands]
  );

  const activeCount =
    (filters.cluster !== "all" ? 1 : 0) +
    (filters.band !== "all" ? 1 : 0) +
    (filters.years.length ? 1 : 0) +
    (filters.pinnedOnly ? 1 : 0) +
    (filters.enrichment !== "all" ? 1 : 0) +
    (filters.polymathOnly ? 1 : 0);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();

    const filtered = candidates.filter((c) => {
      const status = marks[c.slug]?.status ?? "queued";
      if (status !== view) return false;

      if (filters.cluster !== "all" && c.archetype !== filters.cluster) return false;
      // "At least this band" rather than "exactly this band". The old filter was
      // exact, and its option list had no entry for the bottom band at all, so
      // the lowest-scoring people could not be listed.
      if (filters.band !== "all" && c.score < (bandFloor[filters.band] ?? -Infinity)) return false;
      if (filters.years.length && !filters.years.includes(c.graduation_year ?? "")) return false;
      if (filters.pinnedOnly && !marks[c.slug]?.pinned) return false;
      if (filters.enrichment === "enriched" && !c.enriched) return false;
      if (filters.enrichment === "thin" && c.enriched) return false;
      if (filters.polymathOnly && !c.polymath) return false;

      if (term) {
        const hay = [c.name, c.headline, c.school, c.location, c.graduation_year]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });

    return filtered.sort((a, b) => {
      // Pinned always leads, whichever sort is active.
      const pa = marks[a.slug]?.pinned ? 1 : 0;
      const pb = marks[b.slug]?.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      if (sort === "recent") return b.surfaced_at.localeCompare(a.surfaced_at);
      return b.score - a.score;
    });
  }, [candidates, marks, view, filters, search, sort]);

  const visibleSlugs = useMemo(() => rows.map((r) => r.slug), [rows]);
  const checkedRows = useMemo(
    () => rows.filter((r) => checked.has(r.slug)),
    [rows, checked]
  );
  const thinChecked = checkedRows.filter((r) => !r.enriched);

  // Drop checks for rows that are no longer visible, so a bulk action can never
  // hit someone the user cannot see.
  useEffect(() => {
    setChecked((prev) => {
      const next = new Set([...prev].filter((s) => visibleSlugs.includes(s)));
      return next.size === prev.size ? prev : next;
    });
    // An unanswered "delete permanently?" must not survive the list changing
    // underneath it — the confirm button would then name a row that has moved.
    setPendingDelete(null);
  }, [visibleSlugs]);

  async function applyMark(slug: string, change: MarkChange) {
    // Removing someone is one click and easy to misfire, so it is reversible.
    if (change.status === "rejected" || change.status === "known") {
      const previous = marks[slug]?.status ?? "queued";
      const person = roster[slug];
      setUndo({
        slugs: [slug],
        status: previous,
        label: `${person?.name ?? slug} marked ${change.status === "known" ? "already known" : "removed"}.`,
      });
    }
    await mark([slug], change);
  }

  async function bulk(change: MarkChange, label: string) {
    const slugs = checkedRows.map((r) => r.slug);
    if (slugs.length === 0) return;
    if (change.status) {
      setUndo({ slugs, status: view, label: `${slugs.length} ${label}.` });
    }
    await mark(slugs, change);
    setChecked(new Set());
  }

  /** Ask before erasing. The banner carries the consequence; this only names who. */
  function askDelete(slugs: string[]) {
    if (slugs.length === 0) return;
    setUndo(null);
    setNotice(null);
    setPendingDelete({
      slugs,
      label:
        slugs.length === 1
          ? (roster[slugs[0]]?.name ?? slugs[0])
          : `${slugs.length} people`,
    });
  }

  /**
   * Erase for good. No undo banner afterwards, because there is nothing to undo to.
   *
   * The outcome is spelled out rather than left to the row disappearing: a row
   * vanishing is also what rejecting looks like, and these two need to feel different.
   */
  async function erase() {
    const pending = pendingDelete;
    if (!pending) return;
    setPendingDelete(null);
    const ok = await removePeople(pending.slugs);
    if (!ok) return;
    setChecked((prev) => {
      const next = new Set(prev);
      for (const s of pending.slugs) next.delete(s);
      return next;
    });
    setNotice(
      `${pending.label} deleted permanently. Their stored profile is gone, and a sweep will not bring them back.`
    );
  }

  async function bulkEnrich() {
    const slugs = thinChecked.map((r) => r.slug);
    if (slugs.length === 0) return;
    const ok = await enrich(slugs, { kind: "seed", hop: 0 });
    if (ok) setChecked(new Set());
  }

  async function bulkAnalyze() {
    const slugs = checkedRows.map((r) => r.slug);
    if (slugs.length === 0) return;
    const result = await analyze(slugs, true);
    if (result) {
      setNotice(
        result.terms > 0
          ? `Read ${result.terms} term${result.terms === 1 ? "" : "s"} off ${result.tagged} profile${result.tagged === 1 ? "" : "s"}. Review them on the taxonomy screen.`
          : "Nothing new found on those profiles."
      );
      setChecked(new Set());
    }
  }

  function exportCsv() {
    const esc = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const out = [
      ["name", "z_score", "cluster", "polymath", "class", "school", "state", "enriched", "url"],
      ...rows.map((c) => [
        c.name,
        c.score.toFixed(2),
        archetypeLabel(c.archetype),
        c.polymath ? "yes" : "",
        c.graduation_year ?? "",
        c.school ?? "",
        c.state ?? "",
        c.enriched ? "yes" : "no",
        c.url,
      ]),
    ];
    const blob = new Blob([out.map((r) => r.map(esc).join(",")).join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `zscore-queue-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const counts = useMemo(() => {
    const c = { queued: 0, known: 0, rejected: 0 };
    for (const cand of candidates) c[marks[cand.slug]?.status ?? "queued"]++;
    return c;
  }, [candidates, marks]);

  const empty = Object.keys(roster).length === 0;

  return (
    <div className="z-page">
      <div className="z-page-head">
        <p className="z-label">
          {rows.length} {rows.length === 1 ? "person" : "people"}
          {activeCount > 0 || search ? ` of ${counts[view]}` : ""}
        </p>
        <h1 className="z-h1">The queue</h1>
      </div>

      {ephemeral && (
        <div className="z-banner is-error">
          No database is attached, so nothing will be saved. Add an Upstash Redis integration in
          Vercel and redeploy.
        </div>
      )}
      {error && <div className="z-banner is-error">{error}</div>}
      {notice && <div className="z-banner">{notice}</div>}

      {/* Reads before it acts: the two buttons sit after the sentence, not beside a
          name with no room to explain what the click costs. */}
      {pendingDelete && (
        <div className="z-banner is-error z-row z-row-wrap">
          <span>
            Delete <strong>{pendingDelete.label}</strong> permanently? This erases the stored
            profile for everyone and blocks the link, so a sweep will not surface them again.
          </span>
          <span className="z-spacer" />
          <button className="z-linkish is-danger" onClick={erase}>
            Delete
          </button>
          <button className="z-linkish" onClick={() => setPendingDelete(null)}>
            Cancel
          </button>
        </div>
      )}

      {undo && (
        <div className="z-banner z-row">
          <span>{undo.label}</span>
          <span className="z-spacer" />
          <button
            className="z-linkish"
            onClick={async () => {
              await mark(undo.slugs, { status: undo.status });
              setUndo(null);
            }}
          >
            Undo
          </button>
          <button className="z-linkish" onClick={() => setUndo(null)}>
            Dismiss
          </button>
        </div>
      )}

      {empty && !loading ? (
        <EmptyState
          title="Nobody here yet."
          hint={
            <>
              Run a sweep, then add people to the queue. <Link href="/sweep" className="z-linkish is-inline">Go to sweep</Link>
            </>
          }
        />
      ) : (
        <>
          {/* View, search and sort. One line, because all three are always wanted. */}
          <div className="z-row z-row-wrap" style={{ marginBottom: "var(--z-space-5)", gap: "var(--z-space-3)" }}>
            {(
              [
                ["queued", "Queue"],
                ["known", "Already known"],
                ["rejected", "Removed"],
              ] as [View, string][]
            ).map(([id, label]) => (
              <Pill key={id} as="button" active={view === id} onClick={() => setView(id)}>
                {label}
                <span className="z-count">{counts[id]}</span>
              </Pill>
            ))}
            <span className="z-spacer" />
            <input
              className="z-input"
              placeholder="Search name, school, headline"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ maxWidth: 260, padding: "7px 10px", fontSize: "var(--z-fs-small)" }}
              aria-label="Search the queue"
            />
            {/* A single button labelled "By score" cannot say whether that is the
                current state or the thing clicking it does. Two states, both
                visible, and no reading required. */}
            <div className="z-segmented">
              <button
                className="z-segment"
                aria-pressed={sort === "score"}
                onClick={() => setSort("score")}
                title="Highest scoring first"
              >
                Score
              </button>
              <button
                className="z-segment"
                aria-pressed={sort === "recent"}
                onClick={() => setSort("recent")}
                title="Most recently surfaced first"
              >
                Newest
              </button>
            </div>
          </div>

          {/* Filters stay collapsed. Five control groups laid flat is clutter;
              behind a disclosure they cost one line until wanted. */}
          <details className="z-disclosure" style={{ marginBottom: "var(--z-space-6)" }}>
            <summary>
              Filters
              {activeCount > 0 && <span className="z-count">{activeCount} active</span>}
            </summary>
            <div className="z-disclosure-body z-stack" style={{ gap: "var(--z-space-5)" }}>
              <FilterRow label="Cluster">
                <Pill
                  as="button"
                  active={filters.cluster === "all"}
                  onClick={() => setFilter({ cluster: "all" })}
                >
                  All
                </Pill>
                {ARCHETYPES.map((a) => (
                  <Pill
                    key={a.id}
                    as="button"
                    active={filters.cluster === a.id}
                    onClick={() => setFilter({ cluster: a.id })}
                    title={a.blurb}
                  >
                    {a.label}
                  </Pill>
                ))}
              </FilterRow>

              <FilterRow label="Score">
                {bandOptions.map((o) => (
                  <Pill
                    key={o.id}
                    as="button"
                    active={filters.band === o.id}
                    onClick={() => setFilter({ band: o.id })}
                  >
                    {o.label}
                  </Pill>
                ))}
              </FilterRow>

              <FilterRow label="Graduates">
                {YEARS.map((y) => (
                  <Pill
                    key={y}
                    as="button"
                    active={filters.years.includes(y)}
                    onClick={() =>
                      setFilter({
                        years: filters.years.includes(y)
                          ? filters.years.filter((x) => x !== y)
                          : [...filters.years, y],
                      })
                    }
                  >
                    {y}
                  </Pill>
                ))}
              </FilterRow>

              {/**
                * Its own row, because unlike Pinned and Polymath it is a choice
                * rather than a switch, and because "Not enriched" is the one that
                * finishes a job: filter to it, select all, and the bulk bar is
                * already offering to enrich exactly that list at a stated price.
                * As a fourth toggle in "Only show" it could have been on at the
                * same time as Enriched, which is a filter that returns nobody.
                */}
              <FilterRow label="Enrichment">
                {ENRICHMENT_OPTIONS.map((o) => (
                  <Pill
                    key={o.id}
                    as="button"
                    active={filters.enrichment === o.id}
                    onClick={() => setFilter({ enrichment: o.id })}
                    title={o.hint}
                  >
                    {o.label}
                  </Pill>
                ))}
              </FilterRow>

              <FilterRow label="Only show">
                <Pill
                  as="button"
                  active={filters.pinnedOnly}
                  onClick={() => setFilter({ pinnedOnly: !filters.pinnedOnly })}
                >
                  Pinned
                </Pill>
                <Pill
                  as="button"
                  active={filters.polymathOnly}
                  onClick={() => setFilter({ polymathOnly: !filters.polymathOnly })}
                  title="Clears +0.5σ in two or more clusters"
                >
                  Polymath
                </Pill>
              </FilterRow>

              <div className="z-row z-row-wrap">
                {activeCount > 0 && (
                  <button className="z-linkish" onClick={() => setFilter(emptyFilters())}>
                    Clear all
                  </button>
                )}
                <span className="z-spacer" />
                <button className="z-linkish" onClick={exportCsv} disabled={rows.length === 0}>
                  Export CSV
                </button>
              </div>
            </div>
          </details>

          {/* Bulk bar. Appears only with a selection, so it costs nothing idle. */}
          {checkedRows.length > 0 && (
            <div className="z-bulkbar">
              <span className="z-small" style={{ color: "var(--z-ink)" }}>
                {checkedRows.length} selected
              </span>
              <span className="z-spacer" />
              {thinChecked.length > 0 && (
                <Button size="sm" onClick={bulkEnrich} disabled={job.phase === "running"}>
                  Enrich {thinChecked.length}, {formatCost(estimateCost(thinChecked.length))}
                </Button>
              )}
              {taggerEnabled && (
                <Button size="sm" variant="secondary" onClick={bulkAnalyze} disabled={analyzing}>
                  {analyzing ? "Reading" : "Analyze"}
                </Button>
              )}
              <button className="z-linkish" onClick={() => bulk({ pinned: true }, "pinned")}>
                Pin
              </button>
              {view !== "known" && (
                <button className="z-linkish" onClick={() => bulk({ status: "known" }, "marked known")}>
                  Already know
                </button>
              )}
              {view !== "rejected" ? (
                <button className="z-linkish" onClick={() => bulk({ status: "rejected" }, "removed")}>
                  Remove
                </button>
              ) : (
                <button className="z-linkish" onClick={() => bulk({ status: "queued" }, "restored")}>
                  Restore
                </button>
              )}
              {/* Only from Removed. Erasing someone should take two decisions —
                  remove, then delete — and never be adjacent to a triage click in
                  the list you work through every day. */}
              {view === "rejected" && (
                <button
                  className="z-linkish is-danger"
                  onClick={() => askDelete(checkedRows.map((r) => r.slug))}
                  title="Erase these people and their stored profiles. Cannot be undone."
                >
                  Delete
                </button>
              )}
              <button className="z-linkish" onClick={() => setChecked(new Set())}>
                Clear
              </button>
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState
              title={view === "queued" ? "No one matched." : "Nothing here."}
              hint={
                view === "queued"
                  ? "Loosen a filter and try again. The good ones hide in the edges."
                  : undefined
              }
            />
          ) : (
            <>
              <div className="z-table-wrap z-hide-mobile">
                <table className="z-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          aria-label="Select every visible person"
                          checked={checked.size > 0 && checked.size === rows.length}
                          onChange={(e) =>
                            setChecked(e.target.checked ? new Set(visibleSlugs) : new Set())
                          }
                          style={{ accentColor: "var(--z-blue)", width: 15, height: 15 }}
                        />
                      </th>
                      <th>Person</th>
                      <th style={{ width: 200 }}>Z-score</th>
                      <th className="z-cell-cluster">Cluster</th>
                      {/* Wider only where the delete control is offered, so the other
                          two views do not carry an empty gutter for it. */}
                      <th style={{ width: view === "rejected" ? 168 : 120 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <Row
                        key={c.slug}
                        candidate={c}
                        checked={checked.has(c.slug)}
                        onCheck={(on) =>
                          setChecked((prev) => {
                            const next = new Set(prev);
                            if (on) next.add(c.slug);
                            else next.delete(c.slug);
                            return next;
                          })
                        }
                        pinned={Boolean(marks[c.slug]?.pinned)}
                        onMark={applyMark}
                        onCluster={setCluster}
                        onEnrich={() => enrich([c.slug], { kind: "seed", hop: 0 })}
                        enriching={job.phase === "running"}
                        /**
                         * The signals that actually built the number, biggest first.
                         *
                         * This used to be the first five tags of any kind, so a row
                         * could show "Mathematics" and "Computer Science" — worth 0.1
                         * each — while the Z Fellowship that earned most of the score
                         * sat off the end. Reading a row should explain the figure
                         * next to it.
                         */
                        signals={c.signals.filter((x) => x.points > 0)}
                        mark={marks[c.slug]}
                        scoreMax={bands.exceptional}
                        // Offered only where someone has already said no once.
                        onDelete={view === "rejected" ? () => askDelete([c.slug]) : undefined}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="z-stack z-show-mobile">
                {rows.map((c) => (
                  <div className="z-card" key={c.slug}>
                    <PersonCell candidate={c} />
                    <div className="z-row z-row-wrap" style={{ marginTop: "var(--z-space-4)", gap: "var(--z-space-2)" }}>
                      <ZScoreBadge candidate={c} />
                      {c.polymath && <PolymathBadge clusters={c.secondary_archetypes} />}
                      <span className="z-spacer" />
                      <MarkControl
                        slug={c.slug}
                        mark={marks[c.slug]}
                        onChange={applyMark}
                        compact
                      />
                      {view === "rejected" && (
                        <>
                          <span className="z-mark-sep" aria-hidden />
                          <button
                            type="button"
                            className="z-mark-btn is-danger is-compact"
                            onClick={() => askDelete([c.slug])}
                            aria-label={`Delete ${c.name} permanently`}
                          >
                            ⊘
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Row({
  candidate: c,
  checked,
  onCheck,
  pinned,
  onMark,
  onCluster,
  onEnrich,
  enriching,
  signals,
  mark,
  scoreMax,
  onDelete,
}: {
  candidate: Candidate;
  checked: boolean;
  onCheck: (on: boolean) => void;
  pinned: boolean;
  onMark: (slug: string, change: MarkChange) => void;
  onCluster: (slug: string, cluster: Archetype | null) => void;
  onEnrich: () => void;
  enriching: boolean;
  signals: Candidate["signals"];
  mark?: Parameters<typeof MarkControl>[0]["mark"];
  scoreMax: number;
  /** Absent outside the Removed view, where erasing is not on offer. */
  onDelete?: () => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <tr data-pinned={pinned || undefined}>
      <td>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheck(e.target.checked)}
          aria-label={`Select ${c.name}`}
          style={{ accentColor: "var(--z-blue)", width: 15, height: 15 }}
        />
      </td>
      <td>
        <PersonCell candidate={c} year={c.graduation_year} />
        {signals.length > 0 && (
          /* Three, and then a count. Four fitted until the cluster column widened to
             hold its badge, and a row that wraps to four lines stops being scannable
             — which is the only thing this list has to be. The rest is one click
             away on the profile, in full. */
          <span className="z-row" style={{ gap: 4, marginTop: 6 }}>
            {signals.slice(0, 3).map((sg) => (
              <span className="z-sig" key={sg.id} title={`${sg.label} contributes ${sg.points}`}>
                {/* The label is what gets truncated, never the number. Bounding the
                    whole chip clipped the figure instead — "Olentangy Liberty High
                    School 0" for a signal worth 0.3, which is worse than no number. */}
                <span className="z-sig-label">{sg.label}</span>
                <span className="z-sig-n">{sg.points}</span>
              </span>
            ))}
            {signals.length > 3 && (
              <span
                className="z-sig-more"
                title={signals
                  .slice(3)
                  .map((sg) => `${sg.label} ${sg.points}`)
                  .join(", ")}
              >
                +{signals.length - 3}
              </span>
            )}
          </span>
        )}
      </td>
      <td>
        <span className="z-row" style={{ gap: "var(--z-space-4)" }}>
          <ZScoreBadge candidate={c} showClass={false} />
          <DeviationBar z={c.score} max={scoreMax} />
        </span>
        {/* Only offered while there is something to gain, so it disappears once
            this person is enriched rather than sitting there greyed out. */}
        {!c.enriched && (
          <button
            className="z-linkish"
            style={{ marginTop: 4 }}
            onClick={onEnrich}
            disabled={enriching}
            title="Run Apify on this profile, about $0.004"
          >
            Enrich
          </button>
        )}
      </td>
      {/* `z-cell-cluster` refuses to wrap, and the row inside it must not either: a
          wrapping flex container ignores the cell's `white-space`, which is what kept
          stacking the Polymath badge under the cluster instead of letting the column
          take the width it needs. */}
      <td className="z-cell-cluster">
        {editing ? (
          <select
            className="z-input"
            autoFocus
            style={{ padding: "5px 7px", fontSize: "var(--z-fs-micro)" }}
            value={c.archetype}
            onChange={(e) => {
              onCluster(c.slug, e.target.value === "auto" ? null : (e.target.value as Archetype));
              setEditing(false);
            }}
            onBlur={() => setEditing(false)}
          >
            <option value="auto">Automatic</option>
            {ARCHETYPES.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="z-row" style={{ gap: 4 }}>
            <ArchetypeTag archetype={c.archetype} href={`/queue?archetype=${c.archetype}`} />
            {c.polymath && <PolymathBadge clusters={c.secondary_archetypes} />}
            <button
              className="z-linkish z-quiet-action"
              onClick={() => setEditing(true)}
              aria-label={`Change ${c.name}'s cluster`}
              title="Change the cluster by hand"
            >
              edit
            </button>
          </span>
        )}
      </td>
      {/* One row of controls, one baseline. The delete sits in the same group as the
          triage buttons rather than hanging under them as a stray link — but behind a
          hairline, because it is not a triage state, it is the end of the record. */}
      <td>
        <span className="z-row" style={{ gap: "var(--z-space-2)" }}>
          <MarkControl slug={c.slug} mark={mark} onChange={onMark} />
          {onDelete && (
            <>
              <span className="z-mark-sep" aria-hidden />
              <button
                type="button"
                className="z-mark-btn is-danger"
                onClick={onDelete}
                aria-label={`Delete ${c.name} permanently`}
                title="Erase this person and their stored profile. Cannot be undone."
              >
                ⊘
              </button>
            </>
          )}
        </span>
      </td>
    </tr>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="z-label is-quiet" style={{ marginBottom: "var(--z-space-2)" }}>
        {label}
      </p>
      <div className="z-row z-row-wrap">{children}</div>
    </div>
  );
}

export default function QueuePage() {
  return (
    <Suspense fallback={<div className="z-page" />}>
      <QueueInner />
    </Suspense>
  );
}
