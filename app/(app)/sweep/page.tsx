"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COLLEGES,
  GRAD_YEARS,
  HIGH_SCHOOLS,
  PROGRAMS,
  TITLE_KEYWORDS,
} from "@/lib/searchTaxonomy";
import { buildQuery, COST_PER_QUERY, selectionCount, type Selection } from "@/lib/query";
import type { Hit, ShardResult } from "@/lib/types";
import type { CustomTerms, SavedSweep, SweepMode } from "@/lib/state";
import { estimateCost, formatCost, parseSeedInput } from "@/lib/enrichment";
import { isSuppressed, nextHopFrom, suppressionReason, topHonorOf } from "@/lib/people";
import { Button, EmptyState, Pill, SegmentedControl } from "@/components/primitives";
import { useApp } from "@/components/AppState";

/** Sidebar order, top to bottom. */
const CATEGORIES: {
  key: keyof Selection & keyof CustomTerms;
  label: string;
  builtIn: string[];
}[] = [
  { key: "programs", label: "Programs", builtIn: PROGRAMS },
  { key: "titles", label: "Title keywords", builtIn: TITLE_KEYWORDS },
  { key: "colleges", label: "Colleges", builtIn: COLLEGES },
  { key: "highSchools", label: "High schools", builtIn: HIGH_SCHOOLS },
  { key: "years", label: "Class of", builtIn: GRAD_YEARS },
];

const BLANK: Selection = { programs: [], titles: [], colleges: [], highSchools: [], years: [] };

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
  const [maxHops, setMaxHops] = useState(1);
  /** Slugs ticked for the next action, across both paths. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** Neighbours found but not yet enriched, with their seed attribution. */
  const [pendingHop, setPendingHop] = useState<
    { slug: string; seedSlug: string; seedName: string }[]
  >([]);
  const [hopDepth, setHopDepth] = useState(0);
  /** What this visit added, so the results table is about this session. */
  const [sessionSlugs, setSessionSlugs] = useState<string[]>([]);

  const busy = job.phase === "running";

  /** Anyone the viewer has already triaged out. Ticking them again wastes money. */
  const skipReason = useCallback(
    (slug: string) => suppressionReason(marks[slug]),
    [marks]
  );

  const tickable = useCallback(
    (slugs: string[]) => slugs.filter((s) => !isSuppressed(marks[s])),
    [marks]
  );

  // Resume where this teammate left off, once, after the document loads.
  useEffect(() => {
    if (loading || restored) return;
    if (state.lastSelection && !touched.current) {
      selRef.current = state.lastSelection;
      setSel(state.lastSelection);
    }
    if (state.seeds.length > 0 && !seedText) setSeedText(state.seeds.join("\n"));
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, restored]);

  // A completed batch offers the next hop rather than taking it. The user
  // confirms every spend.
  const seenBatch = useRef<number>(0);
  useEffect(() => {
    if (!lastBatch || lastBatch.at === seenBatch.current) return;
    seenBatch.current = lastBatch.at;

    setSessionSlugs((prev) => [...new Set([...prev, ...lastBatch.people.map((p) => p.slug)])]);

    if (hopDepth < maxHops) {
      const known = new Set(Object.keys(roster));
      const found = nextHopFrom(lastBatch.people, known);
      if (found.length > 0) {
        setPendingHop(found);
        setPicked(new Set(tickable(found.slice(0, MAX_PER_RUN).map((f) => f.slug))));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastBatch]);

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
    update({
      ...cur,
      [key]: cur[key].includes(option)
        ? cur[key].filter((x) => x !== option)
        : [...cur[key], option],
    });
  }

  function addTerm(key: keyof CustomTerms, raw: string) {
    const term = raw.trim();
    if (!term) return;
    const all = [...CATEGORIES.find((c) => c.key === key)!.builtIn, ...team.customTerms[key]];
    if (all.some((t) => t.toLowerCase() === term.toLowerCase())) return;
    // Menu options are team-wide, like the taxonomy they feed.
    patchTeam({ customTerms: { ...team.customTerms, [key]: [...team.customTerms[key], term] } });
    update({ ...selRef.current, [key]: [...selRef.current[key], term] });
  }

  function removeTerm(key: keyof CustomTerms, term: string) {
    patchTeam({
      customTerms: {
        ...team.customTerms,
        [key]: team.customTerms[key].filter((t) => t !== term),
      },
    });
    update({ ...selRef.current, [key]: selRef.current[key].filter((t) => t !== term) });
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
        if (already > 0) {
          setNotice(
            `${already} of these you have already triaged, so they start unticked.`
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
      setSessionSlugs((prev) => [...new Set([...prev, ...chosenHits.map((h) => h.slug)])]);
      setNotice(`Added ${chosenHits.length} to the queue on search data. Enrich them any time.`);
    }
    setBusyAction(null);
  }

  async function enrichHits() {
    const slugs = hits.filter((h) => picked.has(h.slug)).map((h) => h.slug);
    if (slugs.length === 0) return;
    setBusyAction("enrich");
    setPendingHop([]);
    setHopDepth(0);
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
    patch({ seeds: slugs });
    setPendingHop([]);
    setSessionSlugs([]);
    setHopDepth(0);
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

  async function enrichHop() {
    const chosenHop = pendingHop.filter((n) => picked.has(n.slug));
    if (chosenHop.length === 0) return;

    const via: Record<string, { seedSlug: string; seedName: string }> = {};
    for (const n of chosenHop) via[n.slug] = { seedSlug: n.seedSlug, seedName: n.seedName };

    setBusyAction("enrich");
    const depth = hopDepth + 1;
    setPendingHop([]);
    setHopDepth(depth);
    await enrich(chosenHop.map((n) => n.slug), { kind: "seed", hop: depth, via });
    setBusyAction(null);
  }

  async function queueHop() {
    const chosenHop = pendingHop.filter((n) => picked.has(n.slug));
    if (chosenHop.length === 0) return;
    setBusyAction("queue");
    // Attribution is per seed, so group before sending.
    const bySeed = new Map<string, { seedName: string; slugs: string[] }>();
    for (const n of chosenHop) {
      const entry = bySeed.get(n.seedSlug) ?? { seedName: n.seedName, slugs: [] };
      entry.slugs.push(n.slug);
      bySeed.set(n.seedSlug, entry);
    }
    for (const [seedSlug, entry] of bySeed) {
      await addSlugs(entry.slugs, { seedSlug, seedName: entry.seedName });
    }
    setPendingHop([]);
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
  const added = sessionSlugs.map((s) => roster[s]).filter(Boolean);

  const hitPickCount = hits.filter((h) => picked.has(h.slug)).length;
  const hopPickCount = pendingHop.filter((n) => picked.has(n.slug)).length;
  const seedCount = parseSeedInput(seedText).slugs.length;
  const working = busy || busyAction !== null;

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

      <div className="z-sweep-grid">
        <aside className="z-stack" style={{ gap: "var(--z-space-3)" }}>
          {mode === "serp" ? (
            CATEGORIES.map((c) => (
              <Category
                key={c.key}
                label={c.label}
                builtIn={c.builtIn}
                custom={team.customTerms[c.key]}
                selected={sel[c.key]}
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
            ))
          ) : (
            <SeedPanel text={seedText} onChange={setSeedText} maxHops={maxHops} onHops={setMaxHops} />
          )}
        </aside>

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
            <div className="z-row z-row-wrap" style={{ marginBottom: "var(--z-space-10)" }}>
              <Button onClick={enrichSeeds} disabled={seedCount === 0 || working}>
                {busy ? "Working" : `Enrich ${seedCount || ""} ${seedCount === 1 ? "seed" : "seeds"}`.trim()}
              </Button>
              <Button variant="secondary" onClick={queueSeeds} disabled={seedCount === 0 || working}>
                Add to queue
              </Button>
              {seedCount > 0 && (
                <span className="z-small">enriching costs about {formatCost(estimateCost(seedCount))}</span>
              )}
            </div>
          )}

          {busy && (
            <div className="z-banner">
              Enriching. This runs on Apify and can take a few minutes. Leaving this page is fine,
              the run keeps going.
            </div>
          )}

          {/* SERP hits, awaiting a decision on who is worth paying for. */}
          {mode === "serp" && ran && hits.length > 0 && (
            <ReviewTable
              title="Search results"
              hint="Untick the noise before you act. Adding to the queue is free; enriching costs about $0.004 each."
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
              onAll={() => setPicked(new Set(tickable(hits.map((h) => h.slug))))}
              onNone={() => setPicked(new Set())}
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

          {/* Neighbours discovered from the last batch, awaiting the same decision. */}
          {pendingHop.length > 0 && (
            <ReviewTable
              title={`People also viewed, hop ${hopDepth + 1}`}
              hint="Found on the profiles just enriched. People Also Viewed reflects who browsers looked at together, so expect some drift."
              rows={pendingHop.slice(0, MAX_PER_RUN).map((n) => ({
                slug: n.slug,
                name: n.slug,
                sub: `via ${n.seedName}`,
                aside: "",
                url: `https://www.linkedin.com/in/${n.slug}`,
                status: rosterStatus(n.slug),
                skip: skipReason(n.slug),
              }))}
              picked={picked}
              onToggle={togglePick}
              onAll={() =>
                setPicked(new Set(tickable(pendingHop.slice(0, MAX_PER_RUN).map((n) => n.slug))))
              }
              onNone={() => setPicked(new Set())}
              action={
                <>
                  <Button onClick={enrichHop} disabled={hopPickCount === 0 || working}>
                    Enrich {hopPickCount}, about {formatCost(estimateCost(hopPickCount))}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={queueHop}
                    disabled={hopPickCount === 0 || working}
                  >
                    Add {hopPickCount} to queue
                  </Button>
                </>
              }
              footnote={
                pendingHop.length > MAX_PER_RUN
                  ? `${pendingHop.length} found, showing the first ${MAX_PER_RUN}.`
                  : undefined
              }
            />
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
                        update(s.selection);
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

function SeedPanel({
  text,
  onChange,
  maxHops,
  onHops,
}: {
  text: string;
  onChange: (v: string) => void;
  maxHops: number;
  onHops: (n: number) => void;
}) {
  return (
    <div className="z-stack" style={{ gap: "var(--z-space-5)" }}>
      <div>
        <p className="z-label is-quiet">Seed profiles</p>
        <p className="z-small" style={{ margin: "var(--z-space-2) 0 var(--z-space-3)" }}>
          People you already know are strong. One LinkedIn URL per line.
        </p>
        <textarea
          className="z-input"
          rows={10}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder={"https://www.linkedin.com/in/ada-chen\nhttps://www.linkedin.com/in/mira-okonkwo"}
          style={{ resize: "vertical", fontSize: "var(--z-fs-small)", lineHeight: 1.6 }}
        />
      </div>

      <div>
        <p className="z-label is-quiet">Expansion</p>
        <p className="z-small" style={{ margin: "var(--z-space-2) 0 var(--z-space-3)" }}>
          How many rounds of People Also Viewed to offer. Each round is reviewed before it runs.
        </p>
        <div className="z-row" style={{ gap: "var(--z-space-2)" }}>
          {[1, 2].map((n) => (
            <Pill key={n} as="button" active={maxHops === n} onClick={() => onHops(n)}>
              {n} hop{n === 1 ? "" : "s"}
            </Pill>
          ))}
        </div>
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
  status: string;
  skip: string | null;
};

function ReviewTable({
  title,
  hint,
  rows,
  picked,
  onToggle,
  onAll,
  onNone,
  action,
  footnote,
}: {
  title: string;
  hint: string;
  rows: ReviewRow[];
  picked: Set<string>;
  onToggle: (slug: string) => void;
  onAll: () => void;
  onNone: () => void;
  action: React.ReactNode;
  footnote?: string;
}) {
  return (
    <div className="z-section-gap">
      <div className="z-col-head">
        <p className="z-label is-quiet">{title}</p>
        <span className="z-spacer" />
        <button className="z-linkish" onClick={onAll}>
          Select all
        </button>
        <button className="z-linkish" onClick={onNone}>
          Clear
        </button>
      </div>
      <p className="z-small" style={{ marginBottom: "var(--z-space-4)", maxWidth: "62ch" }}>
        {hint}
      </p>

      <div className="z-table-wrap">
        <table className="z-table">
          <thead>
            <tr>
              <th style={{ width: 44 }} aria-label="Include" />
              <th>Person</th>
              <th style={{ width: 80 }}>Class</th>
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
