"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GRAD_YEARS } from "@/lib/searchTaxonomy";
import { buildQuery, COST_PER_QUERY, selectionCount, type Selection } from "@/lib/query";
import type { Hit, ShardResult } from "@/lib/types";
import { MAX_RECENT_SLUGS, type CustomTerms, type SavedSweep, type SweepMode } from "@/lib/state";
import type { TagFacet } from "@/lib/tagRegistry";
import { estimateCost, formatCost, parseSeedInput, usableNeighbors } from "@/lib/enrichment";
import { hopAfter, isSuppressed, nextHopFrom, suppressionReason, topHonorOf } from "@/lib/people";
import { Button, EmptyState, Pill, SegmentedControl } from "@/components/primitives";
import { useApp } from "@/components/AppState";

/** Sidebar order, top to bottom. */
/**
 * The sweep menus are the tag registry.
 *
 * Each category maps to a facet, so what you can search for and what the score is
 * made of are the same vocabulary. Adding a tag on the taxonomy screen puts it in
 * these menus, and a term found by the tagger becomes searchable the moment it is
 * promoted — neither of which was true when the menus were separate hardcoded
 * lists.
 *
 * Class years stay a fixed list: they are generated, not curated.
 */
const CATEGORIES: {
  key: keyof Selection & keyof CustomTerms;
  label: string;
  /**
   * Which registry facets fill this menu. More than one where a menu is a place to
   * search rather than a kind of thing: an accelerator is not a programme, but "who
   * else came out of YC" is the same question as "who else did RSI", and both go into
   * the query as keywords.
   */
  facets?: TagFacet[];
  builtIn: string[];
}[] = [
  {
    key: "programs",
    label: "Programs & backers",
    facets: ["accelerator", "program"],
    builtIn: [],
  },
  { key: "titles", label: "Title keywords", facets: ["title"], builtIn: [] },
  { key: "colleges", label: "Colleges", facets: ["college"], builtIn: [] },
  { key: "highSchools", label: "High schools", facets: ["highschool"], builtIn: [] },
  { key: "years", label: "Class of", builtIn: GRAD_YEARS },
  // Two geography menus, because where someone is and where they are from are
  // different questions and often different answers.
  { key: "states", label: "Current state", facets: ["state"], builtIn: [] },
  { key: "homeStates", label: "Home state", facets: ["homestate"], builtIn: [] },
];

const BLANK: Selection = {
  programs: [],
  titles: [],
  colleges: [],
  highSchools: [],
  years: [],
  states: [],
  homeStates: [],
};

/** One run's ceiling, matching the server. Keeps a wide hop from overspending. */
const MAX_PER_RUN = 250;

export default function SweepPage() {
  const {
    state,
    team,
    roster,
    marks,
    patch,
    patchTeam,
    loading,
    ephemeral,
    error,
    setError,
    addHits,
    addSlugs,
    addNeighbors,
    enrich,
    job,
    lastBatch,
  } = useApp();

  const [mode, setMode] = useState<SweepMode>("serp");
  const [sel, setSel] = useState<Selection>(BLANK);
  const [hits, setHits] = useState<Hit[]>([]);
  const [ran, setRan] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Mirrors `sel` synchronously. Reading the state variable instead would lose
  // writes whenever two chips are toggled inside one React batch, since both
  // handlers would compute their next value from the same stale render.
  const selRef = useRef<Selection>(BLANK);
  // Set as soon as the user picks anything, so a late-resolving restore cannot
  // overwrite a selection they already made.
  const touched = useRef(false);

  const [seedText, setSeedText] = useState("");
  /** Slugs ticked for the next action, across both paths. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /**
   * What the recent runs added, so the results table and the sidebar offer are
   * about work just done rather than the whole roster. Persisted, because a
   * reload used to lose the offer entirely even though the neighbours it is built
   * from were saved all along.
   */
  const [sessionSlugs, setSessionSlugs] = useState<string[]>([]);

  /**
   * People Also Viewed is offered, never taken. It stays shut until asked for,
   * and `pavFocus` narrows it to one person's neighbours when a row asks for it.
   */
  const [pavOpen, setPavOpen] = useState(false);
  const [pavFocus, setPavFocus] = useState<string | null>(null);
  const pavRef = useRef<HTMLDetailsElement | null>(null);

  const busy = job.phase === "running";

  /**
   * Everyone the team has erased for good. A search engine does not know they were
   * deleted, so a sweep keeps returning them and the row has to say why it is inert.
   */
  const erased = useMemo(() => new Set(team.deleted), [team.deleted]);

  /** Anyone already triaged out, or deleted. Ticking them again wastes money. */
  const skipReason = useCallback(
    (slug: string) => (erased.has(slug) ? "deleted permanently" : suppressionReason(marks[slug])),
    [marks, erased]
  );

  const tickable = useCallback(
    (slugs: string[]) => slugs.filter((s) => !isSuppressed(marks[s]) && !erased.has(s)),
    [marks, erased]
  );

  /**
   * Record who was just added, in state and in the stored document together, so
   * the offer built from them is still there after a reload.
   */
  function rememberAdded(slugs: string[]) {
    const next = [...new Set([...sessionSlugs, ...slugs])].slice(-MAX_RECENT_SLUGS);
    setSessionSlugs(next);
    patch({ recentSlugs: next });
  }

  // Resume where this teammate left off, once, after the document loads.
  useEffect(() => {
    if (loading || restored) return;
    if (state.lastSelection && !touched.current) {
      // Filled in against BLANK, so a selection stored before a category existed
      // arrives complete. Geography was added after people had already saved one,
      // and reading a missing list crashed this screen on load.
      const restoredSel = { ...BLANK, ...state.lastSelection };
      selRef.current = restoredSel;
      setSel(restoredSel);
    }
    if (state.seeds.length > 0 && !seedText) setSeedText(state.seeds.join("\n"));
    if (state.recentSlugs.length > 0) setSessionSlugs(state.recentSlugs);
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, restored]);

  /**
   * A finished run records who was added and opens the expansion.
   *
   * Opening it is the point: an enrichment's whole purpose in seed mode is to reach
   * the next hop, and leaving it shut meant the run completed and then sat there
   * waiting for a click on a section the user had no reason to suspect had changed.
   * Nothing inside is pre-ticked, so opening it still implies no spend.
   */
  const seenBatch = useRef<number>(0);
  useEffect(() => {
    if (!lastBatch || lastBatch.at === seenBatch.current) return;
    seenBatch.current = lastBatch.at;
    rememberAdded(lastBatch.people.map((p) => p.slug));
    setPavFocus(null);
    setPavOpen(true);
  }, [lastBatch]);

  /**
   * Registry labels grouped by facet, for the menus.
   *
   * Promoted first, then alphabetical: the tags that actually score are the ones
   * worth searching for, and a menu of two hundred alphabetical entries buries
   * them.
   */
  const menuByFacet = useMemo(() => {
    const m = new Map<TagFacet, string[]>();
    const defs = Object.values(team.taxonomy.tags).sort(
      (a, b) =>
        Number(b.promoted) - Number(a.promoted) ||
        b.weight - a.weight ||
        a.label.localeCompare(b.label)
    );
    for (const d of defs) {
      const list = m.get(d.facet) ?? [];
      list.push(d.label);
      m.set(d.facet, list);
    }
    return m;
  }, [team.taxonomy.tags]);

  const query = useMemo(() => buildQuery(sel), [sel]);
  const chosen = selectionCount(sel);

  function update(next: Selection) {
    touched.current = true;
    selRef.current = next;
    setSel(next);
    patch({ lastSelection: next });
  }

  function toggle(key: keyof Selection, option: string) {
    const cur = selRef.current;
    // A stored selection written before this category existed has no list here.
    const held = cur[key] ?? [];
    update({
      ...cur,
      [key]: held.includes(option) ? held.filter((x) => x !== option) : [...held, option],
    });
  }

  function addTerm(key: keyof CustomTerms, raw: string) {
    const term = raw.trim();
    if (!term) return;
    const cat = CATEGORIES.find((c) => c.key === key)!;
    // Check against what the menu actually offers, which is now the registry.
    // Checking `builtIn` alone would let a tag already in the registry be added a
    // second time as a custom term.
    const all = [
      ...(cat.facets ? cat.facets.flatMap((f) => menuByFacet.get(f) ?? []) : cat.builtIn),
      ...team.customTerms[key],
    ];
    if (all.some((t) => t.toLowerCase() === term.toLowerCase())) return;
    // Menu options are team-wide, like the taxonomy they feed.
    patchTeam({ customTerms: { ...team.customTerms, [key]: [...team.customTerms[key], term] } });
    update({ ...selRef.current, [key]: [...(selRef.current[key] ?? []), term] });
  }

  function removeTerm(key: keyof CustomTerms, term: string) {
    patchTeam({
      customTerms: {
        ...team.customTerms,
        [key]: team.customTerms[key].filter((t) => t !== term),
      },
    });
    update({ ...selRef.current, [key]: (selRef.current[key] ?? []).filter((t) => t !== term) });
  }

  async function runSweep() {
    if (!query) return;
    setRunning(true);
    setError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shards: [{ id: "sweep", query }] }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error ?? `Sweep failed (${res.status})`);
        setRunning(false);
        return;
      }

      const result: ShardResult | undefined = data.results?.[0];
      if (result?.error) {
        setError(result.error);
        setHits([]);
      } else {
        const seen = new Set<string>();
        const found = (result?.hits ?? []).filter((h) => {
          if (seen.has(h.slug)) return false;
          seen.add(h.slug);
          return true;
        });
        setHits(found);
        // Everything is ticked except people already triaged out, so a rejection
        // is not silently paid for twice.
        setPicked(new Set(tickable(found.map((h) => h.slug))));

        const already = found.filter((h) => isSuppressed(marks[h.slug])).length;
        const gone = found.filter((h) => erased.has(h.slug)).length;
        if (already > 0 || gone > 0) {
          setNotice(
            [
              already > 0 && `${already} of these you have already triaged`,
              gone > 0 && `${gone} ${gone === 1 ? "was" : "were"} deleted permanently`,
            ]
              .filter(Boolean)
              .join(", and ") + ", so they start unticked."
          );
        }

        const saved: SavedSweep = {
          id: `${Date.now()}`,
          query,
          selection: sel,
          hits: found,
          ranAt: new Date().toISOString(),
          mode: "serp",
        };
        patch({ sweeps: [saved, ...state.sweeps] });
      }

      if (data.freeTier) {
        setNotice(
          `Serper free tier returns ${data.resultsPerQuery} results per query. A paid plan returns up to 100.`
        );
      }
      setRan(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    }

    setRunning(false);
  }

  /* ── The two actions on a selection ─────────────────────────────────────
     Queuing and enriching are different decisions, so they are different
     buttons. Adding is free and instant; enriching costs about $0.004 each and
     upgrades the same record in place afterwards.                          */

  async function queueHits() {
    const chosenHits = hits.filter((h) => picked.has(h.slug));
    if (chosenHits.length === 0) return;
    setBusyAction("queue");
    const ok = await addHits(chosenHits, query, sel);
    if (ok) {
      rememberAdded(chosenHits.map((h) => h.slug));
      setNotice(`Added ${chosenHits.length} to the queue on search data. Enrich them any time.`);
    }
    setBusyAction(null);
  }

  async function enrichHits() {
    const slugs = hits.filter((h) => picked.has(h.slug)).map((h) => h.slug);
    if (slugs.length === 0) return;
    setBusyAction("enrich");
    await enrich(slugs, { kind: "serp", hop: 0, query });
    setBusyAction(null);
  }

  async function enrichSeeds() {
    const { slugs, rejected } = parseSeedInput(seedText);
    if (slugs.length === 0) {
      setError("No usable LinkedIn profile URLs in that list.");
      return;
    }
    if (rejected.length > 0) {
      setNotice(
        `Skipped ${rejected.length} line${rejected.length === 1 ? "" : "s"} that were not profile URLs.`
      );
    }
    setBusyAction("enrich");
    // A fresh seed list starts a fresh run, so the previous run's offer goes.
    patch({ seeds: slugs, recentSlugs: [] });
    setSessionSlugs([]);
    setPavFocus(null);
    setPavOpen(false);
    await enrich(slugs, { kind: "seed", hop: 0 });
    setBusyAction(null);
  }

  async function queueSeeds() {
    const { slugs } = parseSeedInput(seedText);
    if (slugs.length === 0) {
      setError("No usable LinkedIn profile URLs in that list.");
      return;
    }
    setBusyAction("queue");
    patch({ seeds: slugs });
    const ok = await addSlugs(slugs);
    if (ok) setNotice(`Added ${slugs.length} to the queue. They stay thin until enriched.`);
    setBusyAction(null);
  }

  /** One past whoever surfaced the neighbour, from that person's provenance. */
  const hopOf = (seedSlug: string) => hopAfter(roster[seedSlug]);

  async function enrichPav() {
    if (pavPicked.length === 0) return;

    const via: Record<string, { seedSlug: string; seedName: string }> = {};
    for (const n of pavPicked) via[n.slug] = { seedSlug: n.seedSlug, seedName: n.seedName };

    setBusyAction("enrich");
    setPicked(new Set());
    await enrich(pavPicked.map((n) => n.slug), {
      kind: "seed",
      hop: Math.max(...pavPicked.map((n) => hopOf(n.seedSlug))),
      via,
    });
    setBusyAction(null);
  }

  async function queuePav() {
    if (pavPicked.length === 0) return;
    setBusyAction("queue");
    // One call, with each neighbour's own name, position and attribution. The
    // grouped per-seed loop this replaces threw all three away.
    const ok = await addNeighbors(pavPicked, Math.max(...pavPicked.map((n) => hopOf(n.seedSlug))));
    if (ok) {
      rememberAdded(pavPicked.map((n) => n.slug));
      setNotice(
        `Added ${pavPicked.length} to the queue on sidebar data. Enrich them any time.`
      );
      setPicked(new Set());
    }
    setBusyAction(null);
  }

  function togglePick(slug: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function exportCsv() {
    const esc = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [
      ["rank", "name", "headline", "url", "inferred_year", "snippet", "query"],
      ...hits.map((h, i) => [
        String(i + 1),
        h.name,
        h.headline,
        h.url,
        h.inferredYear ?? "",
        h.snippet,
        query,
      ]),
    ];
    const csv = rows.map((r) => r.map(esc).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `zscore-sweep-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const recent = state.sweeps.slice(0, 8);
  const added = useMemo(
    () => sessionSlugs.map((s) => roster[s]).filter(Boolean),
    [sessionSlugs, roster]
  );

  /**
   * The People Also Viewed offer, derived from the roster rather than held in
   * state.
   *
   * Every enrichment returns the sidebar and `writePeople` persists it, so the
   * offer can be recomputed at any time. That is what makes it survive a reload,
   * and it closes the case where a re-poll short-circuits with `alreadyApplied`
   * and no batch is delivered — the neighbours were saved regardless.
   *
   * Because it recomputes, enriching a neighbour folds that person's own sidebar
   * into the next offer. Depth is whatever the user keeps clicking, and anyone
   * already in the roster is filtered out, so it converges rather than looping.
   */
  const known = useMemo(() => new Set(Object.keys(roster)), [roster]);
  const pavAll = useMemo(() => nextHopFrom(added, known), [added, known]);
  const pavRows = useMemo(
    () => (pavFocus ? pavAll.filter((n) => n.seedSlug === pavFocus) : pavAll),
    [pavAll, pavFocus]
  );
  const pavShown = pavRows.slice(0, MAX_PER_RUN);
  /** How many neighbours each added person still has on offer. */
  const pavCountBySeed = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of pavAll) m.set(n.seedSlug, (m.get(n.seedSlug) ?? 0) + 1);
    return m;
  }, [pavAll]);

  /**
   * How many the sidebar returned with no headline. Named on screen rather than
   * letting the list just arrive shorter than the vendor's array was.
   */
  const pavDropped = useMemo(() => {
    const source = pavFocus ? added.filter((p) => p.slug === pavFocus) : added;
    return source.reduce((n, p) => {
      const e = p.enriched;
      if (!e) return n;
      // Older records have no count stored, so recompute from what survives.
      return n + (e.neighborsDropped ?? e.neighbors.length - usableNeighbors(e.neighbors).length);
    }, 0);
  }, [added, pavFocus]);

  const hitPickCount = hits.filter((h) => picked.has(h.slug)).length;
  const pavPicked = pavShown.filter((n) => picked.has(n.slug));
  const seedCount = parseSeedInput(seedText).slugs.length;
  const working = busy || busyAction !== null;

  /**
   * Ticking is scoped to the table it happens in. A shared set with a global
   * clear meant "Clear" under the search results also silently emptied the
   * neighbour selection sitting below it.
   */
  function pickAll(slugs: string[]) {
    setPicked((prev) => new Set([...prev, ...tickable(slugs)]));
  }

  function pickNone(slugs: string[]) {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const s of slugs) next.delete(s);
      return next;
    });
  }

  /** Open the neighbours of one person, from their row in the added table. */
  function focusPav(slug: string) {
    const same = pavFocus === slug && pavOpen;
    setPavFocus(same ? null : slug);
    setPavOpen(!same);
    if (!same) {
      requestAnimationFrame(() =>
        pavRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
      );
    }
  }

  return (
    <div className="z-page">
      <div className="z-page-head">
        <p className="z-label">
          {mode === "serp"
            ? chosen === 0
              ? "Nothing selected"
              : `${chosen} ${chosen === 1 ? "option" : "options"}, about $${COST_PER_QUERY.toFixed(3)}`
            : seedCount === 0
              ? "No seeds yet"
              : `${seedCount} seed ${seedCount === 1 ? "profile" : "profiles"}`}
        </p>
        <h1 className="z-h1">Run a sweep</h1>
      </div>

      <div className="z-row z-row-wrap" style={{ marginBottom: "var(--z-space-8)" }}>
        <SegmentedControl
          label="Sweep mode"
          value={mode}
          onChange={setMode}
          options={[
            { id: "serp", label: "Keyword sweep" },
            { id: "seed", label: "Seed profiles" },
          ]}
        />
        <span className="z-spacer" />
        {mode === "serp" && chosen > 0 && (
          <button className="z-linkish" onClick={() => update({ ...BLANK })}>
            Clear all
          </button>
        )}
      </div>

      {ephemeral && (
        <div className="z-banner is-error">
          No database is attached, so nothing will be saved. Add an Upstash Redis integration in
          Vercel and redeploy.
        </div>
      )}
      {error && <div className="z-banner is-error">{error}</div>}
      {job.error && <div className="z-banner is-error">{job.error}</div>}
      {notice && <div className="z-banner">{notice}</div>}
      {job.note && busy && <div className="z-banner">{job.note}</div>}

      <div className={mode === "serp" ? "z-sweep-grid" : undefined}>
        {mode === "serp" && (
          <aside className="z-stack" style={{ gap: "var(--z-space-3)" }}>
            {CATEGORIES.map((c) => (
              <Category
                key={c.key}
                label={c.label}
                builtIn={c.facets ? c.facets.flatMap((f) => menuByFacet.get(f) ?? []) : c.builtIn}
                custom={team.customTerms[c.key] ?? []}
                selected={sel[c.key] ?? []}
                onToggle={(o) => toggle(c.key, o)}
                onAdd={(t) => addTerm(c.key, t)}
                onRemove={(t) => removeTerm(c.key, t)}
                onAll={() =>
                  update({
                    ...selRef.current,
                    [c.key]: [...c.builtIn, ...team.customTerms[c.key]],
                  })
                }
                onClear={() => update({ ...selRef.current, [c.key]: [] })}
              />
            ))}
          </aside>
        )}

        <div style={{ minWidth: 0 }}>
          {mode === "serp" ? (
            <>
              <div className="z-query">
                <div className="z-query-text">
                  {query || (
                    <span style={{ color: "var(--z-ink-faint)" }}>
                      Pick something on the left and the query builds here.
                    </span>
                  )}
                </div>
              </div>

              <div
                className="z-row z-row-wrap"
                style={{ margin: "var(--z-space-5) 0 var(--z-space-10)" }}
              >
                <Button onClick={runSweep} disabled={!query || running || working}>
                  {running ? "Searching" : "Run sweep"}
                </Button>
                <Button variant="secondary" onClick={exportCsv} disabled={!hits.length}>
                  Export CSV
                </Button>
                {ran && !running && (
                  <span className="z-small">
                    {hits.length} {hits.length === 1 ? "person" : "people"} found
                  </span>
                )}
              </div>
            </>
          ) : (
            <SeedComposer
              text={seedText}
              onChange={setSeedText}
              onEnrich={enrichSeeds}
              onQueue={queueSeeds}
              busy={busy}
              working={working}
            />
          )}

          {/* SERP hits, awaiting a decision on who is worth paying for. */}
          {mode === "serp" && ran && hits.length > 0 && (
            <ReviewTable
              title="Search results"
              rows={hits.map((h) => ({
                slug: h.slug,
                name: h.name || h.slug,
                sub: h.headline,
                aside: h.inferredYear ?? "",
                url: h.url,
                status: rosterStatus(h.slug),
                skip: skipReason(h.slug),
              }))}
              picked={picked}
              onToggle={togglePick}
              onAll={() => pickAll(hits.map((h) => h.slug))}
              onNone={() => pickNone(hits.map((h) => h.slug))}
              action={
                <>
                  <Button onClick={enrichHits} disabled={hitPickCount === 0 || working}>
                    Enrich {hitPickCount}, about {formatCost(estimateCost(hitPickCount))}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={queueHits}
                    disabled={hitPickCount === 0 || working}
                  >
                    Add {hitPickCount} to queue
                  </Button>
                </>
              }
            />
          )}

          {mode === "serp" && ran && hits.length === 0 && (
            <EmptyState
              title="No one matched."
              hint="Drop an option to widen the query and try again."
            />
          )}
          {mode === "serp" && !ran && (
            <EmptyState title="Nothing swept yet." hint="Build a query on the left, then run it." />
          )}

          {/* Who the added people were co-viewed with. Shut until asked for, and
              it costs nothing to look, because the sidebar arrived with the
              enrichment already paid for. */}
          {pavAll.length > 0 && (
            <details
              ref={pavRef}
              className="z-disclosure z-section-gap"
              open={pavOpen}
              onToggle={(e) => setPavOpen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>
                People also viewed
                <span className="z-count">
                  {pavFocus
                    ? `${pavRows.length} via ${roster[pavFocus]?.name || pavFocus}`
                    : `${pavAll.length} found`}
                </span>
              </summary>
              <div className="z-disclosure-body">
                <ReviewTable
                  nested
                  title={pavFocus ? "Co-viewed with this person" : "Co-viewed"}
                  rows={pavShown.map((n) => ({
                    slug: n.slug,
                    name: n.name || n.slug,
                    sub: n.position,
                    aside: n.year ?? "",
                    url: n.url,
                    via: n.seedName,
                    status: rosterStatus(n.slug),
                    skip: skipReason(n.slug),
                  }))}
                  picked={picked}
                  onToggle={togglePick}
                  onAll={() => pickAll(pavShown.map((n) => n.slug))}
                  onNone={() => pickNone(pavShown.map((n) => n.slug))}
                  extra={
                    pavFocus ? (
                      <button className="z-linkish" onClick={() => setPavFocus(null)}>
                        Show all
                      </button>
                    ) : undefined
                  }
                  action={
                    <>
                      <Button onClick={enrichPav} disabled={pavPicked.length === 0 || working}>
                        Enrich {pavPicked.length}, about{" "}
                        {formatCost(estimateCost(pavPicked.length))}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={queuePav}
                        disabled={pavPicked.length === 0 || working}
                      >
                        Add {pavPicked.length} to queue
                      </Button>
                    </>
                  }
                  footnote={
                    [
                      pavRows.length > MAX_PER_RUN
                        ? `${pavRows.length} found, showing the first ${MAX_PER_RUN}.`
                        : "",
                      pavDropped > 0
                        ? `${pavDropped} more came back outside the co-view block and were left out.`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                />
              </div>
            </details>
          )}

          {/* Everything this visit put into the roster. */}
          {added.length > 0 && (
            <div className="z-section-gap">
              <div className="z-col-head">
                <p className="z-label is-quiet">Added this session, {added.length}</p>
              </div>
              <div className="z-table-wrap">
                <table className="z-table">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th style={{ width: 80 }}>Class</th>
                      <th style={{ width: 200 }}>Top honor</th>
                      <th style={{ width: 130 }}>State</th>
                      <th style={{ width: 150 }} aria-label="Also viewed" />
                    </tr>
                  </thead>
                  <tbody>
                    {added.map((p) => (
                      <tr key={p.slug}>
                        <td>
                          <a
                            href={p.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="z-person-name"
                          >
                            {p.name}
                          </a>
                          <span className="z-person-sub">
                            {[p.headline, p.school].filter(Boolean).join(", ")}
                          </span>
                        </td>
                        <td className="z-num">{p.gradYear ?? p.inferredYear ?? ""}</td>
                        <td className="z-small">
                          {topHonorOf(p) ?? (p.enriched ? "" : "not enriched")}
                        </td>
                        <td className="z-micro">{p.state ?? ""}</td>
                        {/* Quiet until the row is hovered or focused, because it is
                            an aside on every row and a column of links is noise. */}
                        <td>
                          {(pavCountBySeed.get(p.slug) ?? 0) > 0 && (
                            <button
                              className="z-linkish z-quiet-action"
                              onClick={() => focusPav(p.slug)}
                              aria-expanded={pavFocus === p.slug && pavOpen}
                              style={{ whiteSpace: "nowrap" }}
                            >
                              {pavCountBySeed.get(p.slug)} also viewed
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {recent.length > 0 && (
            <details className="z-disclosure z-section-gap">
              <summary>
                Your recent sweeps
                <span className="z-count">{state.sweeps.length}</span>
              </summary>
              <div className="z-disclosure-body z-stack" style={{ gap: "var(--z-space-4)" }}>
                {recent.map((s) => (
                  <div
                    key={s.id}
                    className="z-row"
                    style={{ alignItems: "flex-start", gap: "var(--z-space-4)" }}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="z-small" style={{ color: "var(--z-ink)", display: "block" }}>
                        {s.query}
                      </span>
                      <span className="z-micro">
                        {new Date(s.ranAt).toLocaleString()}, {s.hits.length} found
                      </span>
                    </span>
                    <button
                      className="z-linkish"
                      style={{ flex: "none" }}
                      onClick={() => {
                        setMode("serp");
                        update({ ...BLANK, ...s.selection });
                        setHits(s.hits);
                        setPicked(new Set(tickable(s.hits.map((h) => h.slug))));
                        setRan(true);
                      }}
                    >
                      Load
                    </button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );

  function rosterStatus(slug: string): string {
    const p = roster[slug];
    if (!p) return "";
    return p.enriched ? "enriched" : "in queue";
  }
}

/* ── Seed input ─────────────────────────────────────────────────────────── */

/**
 * The seed composer.
 *
 * Replaces a textarea sitting in a menu rail beside two buttons, which left the
 * keyword sweep's two-column grid half empty in seed mode. Here the paste surface
 * is the whole subject of the screen, so it gets the width and the focus.
 *
 * The parse is shown, not described. Every line is resolved as it is typed and the
 * result comes back as chips, so what the tool understood is visible before any
 * money is spent — which is the same reason a rejected line is named rather than
 * silently dropped. That replaces the paragraph explaining what the field wants.
 */
function SeedComposer({
  text,
  onChange,
  onEnrich,
  onQueue,
  busy,
  working,
}: {
  text: string;
  onChange: (v: string) => void;
  onEnrich: () => void;
  onQueue: () => void;
  busy: boolean;
  working: boolean;
}) {
  const { slugs, rejected } = useMemo(() => parseSeedInput(text), [text]);
  const empty = text.trim().length === 0;

  return (
    <div style={{ maxWidth: 680 }}>
      <textarea
        className="z-seed-input"
        rows={empty ? 5 : 7}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder={"Paste LinkedIn profile URLs, one per line"}
        aria-label="Seed profile URLs"
        spellCheck={false}
      />

      {/* What was understood, as chips. A rejected line is named so a typo is
          fixable rather than mysterious. */}
      {slugs.length > 0 && (
        <div
          className="z-row z-row-wrap"
          style={{ gap: "var(--z-space-2)", marginTop: "var(--z-space-4)" }}
        >
          {slugs.map((slug) => (
            <span key={slug} className="z-pill">
              {slug}
            </span>
          ))}
        </div>
      )}

      {rejected.length > 0 && (
        <p className="z-micro" style={{ marginTop: "var(--z-space-3)" }}>
          Not a profile URL: {rejected.slice(0, 3).join(", ")}
          {rejected.length > 3 ? ` and ${rejected.length - 3} more` : ""}
        </p>
      )}

      <div
        className="z-row z-row-wrap"
        style={{ marginTop: "var(--z-space-6)", gap: "var(--z-space-3)" }}
      >
        <Button onClick={onEnrich} disabled={slugs.length === 0 || working}>
          {busy
            ? "Enriching"
            : slugs.length === 0
              ? "Enrich"
              : `Enrich ${slugs.length}, ${formatCost(estimateCost(slugs.length))}`}
        </Button>
        <Button variant="secondary" onClick={onQueue} disabled={slugs.length === 0 || working}>
          Add to queue
        </Button>
        {busy && (
          <span className="z-micro">Runs in the background, so you can leave this page.</span>
        )}
      </div>
    </div>
  );
}

/* ── Review table ─ shared by SERP hits and each hop ────────────────────── */

type ReviewRow = {
  slug: string;
  name: string;
  sub: string;
  aside: string;
  url: string;
  /** Who surfaced this person. Only the sidebar rows have one. */
  via?: string;
  status: string;
  skip: string | null;
};

function ReviewTable({
  title,
  rows,
  picked,
  onToggle,
  onAll,
  onNone,
  action,
  extra,
  nested,
  footnote,
}: {
  title: string;
  rows: ReviewRow[];
  picked: Set<string>;
  onToggle: (slug: string) => void;
  onAll: () => void;
  onNone: () => void;
  action: React.ReactNode;
  /** An extra control in the header, left of Clear. */
  extra?: React.ReactNode;
  /** Inside a disclosure the section rhythm is already spent on the summary. */
  nested?: boolean;
  footnote?: string;
}) {
  // The header box judges "all selected" against the rows `onAll` would actually
  // tick. Suppressed rows are not among them, so counting every row instead
  // would leave the box permanently unchecked whenever one person was triaged
  // out earlier.
  const tickable = rows.filter((r) => !r.skip);
  const pickedCount = tickable.filter((r) => picked.has(r.slug)).length;
  const allPicked = tickable.length > 0 && pickedCount === tickable.length;
  // Only the sidebar rows carry attribution, so the column appears with them
  // rather than sitting empty above the search results.
  const showVia = rows.some((r) => r.via);

  return (
    <div className={nested ? undefined : "z-section-gap"}>
      <div className="z-col-head">
        <p className="z-label is-quiet">{title}</p>
        <span className="z-spacer" />
        {extra}
        <button className="z-linkish" onClick={onNone}>
          Clear
        </button>
      </div>
      <div className="z-table-wrap">
        <table className="z-table">
          <thead>
            <tr>
              {/* Sits directly above the row boxes and toggles both ways, so the
                  same control that ticks everyone unticks them again. */}
              <th style={{ width: 44 }}>
                <input
                  type="checkbox"
                  checked={allPicked}
                  // React has no `indeterminate` prop, so a partial selection has
                  // to be written onto the node.
                  ref={(el) => {
                    if (el) el.indeterminate = pickedCount > 0 && !allPicked;
                  }}
                  onChange={() => (allPicked ? onNone() : onAll())}
                  disabled={tickable.length === 0}
                  aria-label={allPicked ? "Unselect all" : "Select all"}
                  title={allPicked ? "Unselect all" : "Select all"}
                  style={{ accentColor: "var(--z-blue)", width: 15, height: 15 }}
                />
              </th>
              <th>Person</th>
              <th style={{ width: 80 }}>Class</th>
              {showVia && <th style={{ width: 140 }}>Via</th>}
              <th style={{ width: 150 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.slug} data-dimmed={r.skip ? true : undefined}>
                <td>
                  <input
                    type="checkbox"
                    checked={picked.has(r.slug)}
                    onChange={() => onToggle(r.slug)}
                    aria-label={`Include ${r.name}`}
                    style={{ accentColor: "var(--z-blue)", width: 15, height: 15 }}
                  />
                </td>
                <td>
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="z-person-name">
                    {r.name}
                  </a>
                  <span className="z-person-sub">{r.sub}</span>
                </td>
                <td className="z-num">{r.aside}</td>
                {showVia && <td className="z-micro">{r.via ?? ""}</td>}
                <td className="z-micro">
                  {/* A person triaged out earlier says so, so a rejection is not
                      quietly paid for a second time. */}
                  {r.skip ?? r.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="z-row z-row-wrap" style={{ marginTop: "var(--z-space-5)" }}>
        {action}
        {footnote && <span className="z-small">{footnote}</span>}
      </div>
    </div>
  );
}

function Category({
  label,
  builtIn,
  custom,
  selected,
  onToggle,
  onAdd,
  onRemove,
  onAll,
  onClear,
}: {
  label: string;
  builtIn: string[];
  custom: string[];
  selected: string[];
  onToggle: (option: string) => void;
  onAdd: (term: string) => void;
  onRemove: (term: string) => void;
  onAll: () => void;
  onClear: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const options = [...builtIn, ...custom];

  function commit() {
    onAdd(draft);
    setDraft("");
    setAdding(false);
  }

  return (
    <details className="z-disclosure">
      <summary>
        {label}
        <span className="z-count">
          {selected.length > 0 ? `${selected.length} selected` : options.length}
        </span>
      </summary>
      <div className="z-disclosure-body">
        <div className="z-row z-row-wrap" style={{ gap: "var(--z-space-2)" }}>
          {builtIn.map((o) => (
            <Pill key={o} as="button" active={selected.includes(o)} onClick={() => onToggle(o)}>
              {o}
            </Pill>
          ))}
          {/* Added by the team. Removable, since they own them. */}
          {custom.map((o) => (
            <span key={o} className="z-custom-term">
              <Pill as="button" active={selected.includes(o)} onClick={() => onToggle(o)}>
                {o}
              </Pill>
              <button
                className="z-custom-remove"
                onClick={() => onRemove(o)}
                aria-label={`Remove ${o}`}
                title={`Remove ${o}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>

        {adding ? (
          <div className="z-row" style={{ marginTop: "var(--z-space-3)", gap: "var(--z-space-2)" }}>
            <input
              className="z-input"
              autoFocus
              placeholder={`Add to ${label.toLowerCase()}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setDraft("");
                  setAdding(false);
                }
              }}
              style={{ padding: "6px 10px", fontSize: "var(--z-fs-small)" }}
            />
            <Button size="sm" onClick={commit} disabled={!draft.trim()}>
              Add
            </Button>
          </div>
        ) : (
          <div className="z-row" style={{ marginTop: "var(--z-space-4)" }}>
            <button className="z-linkish" onClick={() => setAdding(true)}>
              Add your own
            </button>
            <span className="z-spacer" />
            <button className="z-linkish" onClick={onAll}>
              Select all
            </button>
            <button className="z-linkish" onClick={onClear}>
              Clear
            </button>
          </div>
        )}
      </div>
    </details>
  );
}
