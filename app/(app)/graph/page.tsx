"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/components/AppState";
import {
  DEFAULT_MAX_HOLDERS,
  DEFAULT_MIN_HOLDERS,
  EDGE_SOURCES,
  GROUP_BY,
  NODE_CAP,
  SWEEP_KEY_FOR_FACET,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  buildGraph,
  edgePath,
  neighborsOf,
  type EdgeSource,
  type GraphNode,
  type GroupBy,
  type Hub,
} from "@/lib/graph";
import { EMPTY_SELECTION } from "@/lib/query";
import { ARCHETYPES, archetypeLabel, formatSigma } from "@/lib/zscore";
import type { TagFacet } from "@/lib/tagRegistry";
import {
  ArchetypeTag,
  EmptyState,
  MarkControl,
  Pill,
  PolymathBadge,
  ZScoreBadge,
} from "@/components/primitives";

/**
 * The graph. Desktop-primary.
 *
 * Three things happen here, and the screen is built in that order:
 *
 *   1. **See the shape.** People as nodes, sized by score, coloured by cluster.
 *   2. **Ask why.** Focus anyone and the canvas isolates their connections while
 *      the panel names each one — "Grace Liu · RSI, Jane Street". A link you cannot
 *      read the reason for is decoration.
 *   3. **Act on it.** Every thing two or more people share becomes a lead under the
 *      canvas, ranked by how much talent it has already produced, and one click
 *      turns a lead into a sweep. That is the step that makes this a discovery tool
 *      rather than a diagram.
 *
 * Rendered client-only behind a mounted flag. The layout is deterministic but it is
 * still floating-point trigonometry, and Node and the browser are permitted to
 * disagree in the last digit — which shows up as a hydration mismatch rather than as
 * anything visible. Computing it only on the client removes the whole class of bug
 * instead of rounding around it.
 */

const SOURCE_LABEL: Record<EdgeSource, string> = {
  discovery: "Found via",
  program: "Programs",
  company: "Companies",
  highschool: "High school",
  college: "College",
};

/** What a shared one actually tells you, for the control's tooltip. */
const SOURCE_HINT: Record<EdgeSource, string> = {
  discovery:
    "Who was found on whose People also viewed. The only link that is a fact about the search rather than an inference about the people.",
  program: "Both cleared the same selective filter — the same programme, fellowship or award.",
  company: "Both worked at the same company, fund or organisation.",
  highschool: "Both went to the same high school. Rare, and a pipeline you can go and sweep.",
  college: "Both go to the same university. Broad by nature, so it is off until you ask for it.",
};

const GROUP_LABEL: Record<GroupBy, string> = {
  none: "Connections",
  cluster: "Cluster",
  year: "Class",
  home: "Home",
};

const GROUP_HINT: Record<GroupBy, string> = {
  none: "No anchors. The links decide who sits next to whom, which is the arrangement that actually carries information.",
  cluster: "Pull each archetype to its own quarter of the canvas.",
  year: "Pull by college class, so who is available when reads at a glance.",
  home: "Pull by the home state inferred from their high school — the geography of the pipeline.",
};

/** Three families, because a chip should read as its kind at a glance. */
const FACET_FAMILY: Partial<Record<TagFacet, string>> = {
  program: "program",
  award: "program",
  company: "company",
  org: "company",
  college: "school",
  highschool: "school",
};

const FACET_NOUN: Partial<Record<TagFacet, string>> = {
  program: "Program",
  award: "Award",
  company: "Company",
  org: "Organisation",
  college: "College",
  highschool: "High school",
};

export default function GraphPage() {
  const { candidates, roster, team, marks, queue, mark, patch, loading } = useApp();
  const router = useRouter();

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  /**
   * Everything rare, nothing broad.
   *
   * Found via is a fact, and a shared programme, employer or high school is rare
   * enough that a line between two people means something. College is the one that
   * is off, because twelve of twenty are at Stanford: drawing it first connects
   * most of the queue to most of the queue and buries the links worth seeing.
   */
  const [sources, setSources] = useState<EdgeSource[]>([
    "discovery",
    "program",
    "company",
    "highschool",
  ]);
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  /**
   * People, until asked otherwise.
   *
   * Hub nodes multiply the node count and the graph is about the people. Opening on
   * the dense view meant the first thing anyone saw was the hardest thing to read.
   */
  const [showTags, setShowTags] = useState(false);
  const [maxHolders, setMaxHolders] = useState(DEFAULT_MAX_HOLDERS);
  const [search, setSearch] = useState("");
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // Pan and zoom, hand-rolled. d3-zoom would be a dependency for forty lines.
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const dragging = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  /** The graph shows the queue: the people this teammate is actually working. */
  const queued = useMemo(
    () => candidates.filter((c) => (marks[c.slug]?.status ?? "queued") === "queued"),
    [candidates, marks]
  );

  const graph = useMemo(
    () =>
      buildGraph(queued, roster, team.taxonomy, {
        sources,
        groupBy,
        showTags,
        minHolders: DEFAULT_MIN_HOLDERS,
        maxHolders,
        cap: NODE_CAP,
      }),
    [queued, roster, team.taxonomy, sources, groupBy, showTags, maxHolders]
  );

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  /**
   * Where to write each group's name.
   *
   * Arranging by class or home state without saying which cluster is which tells
   * you that there are clusters and nothing else — the whole value of the control
   * is in the labels. Derived from the laid-out nodes rather than from the anchors
   * the layout used, because a group's members end up wherever the forces put them
   * and the label has to sit above *that*, not above where it was aimed.
   */
  const groupLabels = useMemo(() => {
    if (graph.groups.length === 0) return [];
    const box = new Map<string, { x1: number; x2: number; y: number }>();
    for (const n of graph.nodes) {
      if (n.kind !== "person" || !n.group) continue;
      const r = n.r;
      const b = box.get(n.group);
      box.set(
        n.group,
        b
          ? { x1: Math.min(b.x1, n.x - r), x2: Math.max(b.x2, n.x + r), y: Math.min(b.y, n.y - r) }
          : { x1: n.x - r, x2: n.x + r, y: n.y - r }
      );
    }
    return [...box.entries()].map(([label, b]) => ({
      label,
      x: (b.x1 + b.x2) / 2,
      // Nudged inside the frame, so a group that settled against the top edge is
      // still named rather than clipped.
      y: Math.max(14, b.y - 11),
    }));
  }, [graph.nodes, graph.groups]);
  const hubById = useMemo(() => new Map(graph.hubs.map((h) => [h.id, h])), [graph.hubs]);

  const focus = selected ?? hovered;

  /**
   * What stays lit.
   *
   * A lead can be focused whether or not it is drawn, so this resolves a hub id
   * through `hubs` first: in People mode the chip is not on the canvas but its
   * holders still light up, which is what makes the leads strip work as a
   * highlighter over either view.
   */
  const lit = useMemo(() => {
    if (!focus) return null;
    const hub = hubById.get(focus);
    if (hub) return new Set([focus, ...hub.slugs.map((s) => `p:${s}`)]);
    return neighborsOf(graph.edges, focus);
  }, [focus, hubById, graph.edges]);

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return null;
    return new Set(
      graph.nodes.filter((n) => n.label.toLowerCase().includes(term)).map((n) => n.id)
    );
  }, [search, graph.nodes]);

  const selectedNode = selected ? byId.get(selected) : undefined;
  const selectedHub = selected ? hubById.get(selected) : undefined;
  const selectedCandidate =
    selectedNode?.kind === "person"
      ? queued.find((c) => c.slug === selectedNode.slug)
      : undefined;

  function toggleSource(s: EdgeSource) {
    setSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  const zoom = useCallback((factor: number) => {
    setView((v) => ({ ...v, k: Math.min(Math.max(v.k * factor, 0.4), 4) }));
  }, []);

  /**
   * Zoom on pinch or ctrl-wheel. A plain wheel scrolls the page.
   *
   * Two things were wrong with the obvious version. React attaches `wheel` as a
   * passive listener, so `preventDefault` inside `onWheel` silently does nothing —
   * which meant one flick of the trackpad scrolled the page *and* zoomed the graph
   * to its floor at the same time. And even with that fixed, a canvas this size
   * swallowing the scroll wheel traps anyone trying to get past it.
   *
   * So the gesture is the one every map and canvas already uses: ctrl or cmd held,
   * which is also exactly what a trackpad pinch sends. The − / + buttons cover
   * everyone who does not know that.
   */
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.1 : 0.91);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, mounted]);

  function onPointerDown(e: React.PointerEvent) {
    if ((e.target as Element).closest("[data-node]")) return;
    dragging.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragging.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.ox + (e.clientX - d.x) / v.k, y: d.oy + (e.clientY - d.y) / v.k }));
  }

  function onPointerUp() {
    dragging.current = null;
  }

  const recentre = useCallback(() => {
    setView({ x: 0, y: 0, k: 1 });
    setSelected(null);
    setSearch("");
  }, []);

  /**
   * Turn a lead into a sweep.
   *
   * Replaces the stored selection rather than adding to it: a lead is a single
   * question ("who else did RSI"), and folding it into whatever was left over from
   * last time would send a query nobody asked for. Nothing is spent — the sweep
   * screen opens with the one term ticked and the user still presses the button.
   */
  const sweepFor = useCallback(
    (hub: Hub) => {
      const key = SWEEP_KEY_FOR_FACET[hub.facet];
      if (!key) return;
      patch({ lastSelection: { ...EMPTY_SELECTION, [key]: [hub.label] } });
      router.push("/sweep");
    },
    [patch, router]
  );

  const empty = queue.length === 0;
  const people = graph.nodes.filter((n) => n.kind === "person").length;

  return (
    <div className="z-page">
      <div className="z-page-head">
        <p className="z-label">
          {people} {people === 1 ? "person" : "people"} · {graph.edges.length}{" "}
          {graph.edges.length === 1 ? "link" : "links"}
        </p>
        <h1 className="z-h1">The graph</h1>
      </div>

      {empty && !loading ? (
        <EmptyState
          title="Nothing to plot yet."
          hint={
            <>
              The graph draws your queue.{" "}
              <Link href="/sweep" className="z-linkish">
                Run a sweep
              </Link>{" "}
              and add some people.
            </>
          }
        />
      ) : (
        <>
          {/* Three rows, one decision each, with the two keyed rows sharing a
              gutter so their pills start on the same line. Packing the mode switch
              and the link types onto one row read as one control with a divider in
              it, which is not what it is. */}
          <div className="z-graph-controls z-hide-mobile">
            <div className="z-row" style={{ gap: "var(--z-space-3)" }}>
              <div className="z-segmented">
                <button
                  className="z-segment"
                  aria-pressed={!showTags}
                  onClick={() => setShowTags(false)}
                  title="People only. Two people are joined when they share something, and the panel names what."
                >
                  People
                </button>
                <button
                  className="z-segment"
                  aria-pressed={showTags}
                  onClick={() => setShowTags(true)}
                  title="Draw the shared thing itself, labelled, with its people around it."
                >
                  Hubs
                </button>
              </div>
              <span className="z-spacer" />
              <input
                className="z-input z-graph-find"
                placeholder="Find"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Find a person or a shared thing"
              />
            </div>

            <div className="z-graph-line">
              <span className="z-label is-quiet z-graph-key">Links</span>
              <div className="z-row z-row-wrap" style={{ gap: "var(--z-space-2)" }}>
                {EDGE_SOURCES.map((s) => (
                  <Pill
                    key={s}
                    as="button"
                    active={sources.includes(s)}
                    onClick={() => toggleSource(s)}
                    title={SOURCE_HINT[s]}
                  >
                    {SOURCE_LABEL[s]}
                  </Pill>
                ))}
              </div>
            </div>

            <div className="z-graph-line">
              <span className="z-label is-quiet z-graph-key">Arrange</span>
              <div className="z-row z-row-wrap" style={{ gap: "var(--z-space-2)" }}>
                {GROUP_BY.map((g) => (
                  <Pill
                    key={g}
                    as="button"
                    active={groupBy === g}
                    onClick={() => setGroupBy(g)}
                    title={GROUP_HINT[g]}
                  >
                    {GROUP_LABEL[g]}
                  </Pill>
                ))}
              </div>
              <span className="z-spacer" />
              {/* Only means anything once hubs are drawn. */}
              {showTags && (
                <label
                  className="z-row z-micro"
                  style={{ gap: 8, flex: "none" }}
                  title="A thing most of the queue shares is not a connection between any two of them. Above this it drops out of the picture and stays in the leads."
                >
                  Hubs up to
                  <input
                    type="range"
                    min={2}
                    max={30}
                    step={1}
                    value={maxHolders}
                    onChange={(e) => setMaxHolders(Number(e.target.value))}
                    className="z-graph-range"
                    aria-label="Largest hub to draw, in people"
                  />
                  <span className="z-num">{maxHolders}</span> people
                </label>
              )}
            </div>
          </div>

          <div className="z-graph-wrap z-hide-mobile">
            {!mounted ? (
              <div className="z-graph-loading z-small">Laying out the graph</div>
            ) : (
              <svg
                ref={svgRef}
                className="z-graph"
                viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
                role="img"
                aria-label={`Relationship graph of ${queued.length} people`}
              >
                <defs>
                  {/* Discovery runs one way — seed to found — and which way is the
                      useful half, so it is the one edge type that carries a head. */}
                  <marker
                    id="z-arrow"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="5"
                    markerHeight="5"
                    orient="auto"
                  >
                    <path d="M0 1L7 4L0 7Z" className="z-graph-arrow" />
                  </marker>
                </defs>

                <g
                  transform={`translate(${VIEW_WIDTH / 2} ${VIEW_HEIGHT / 2}) scale(${view.k}) translate(${-VIEW_WIDTH / 2 + view.x} ${-VIEW_HEIGHT / 2 + view.y})`}
                >
                  {groupLabels.map((g) => (
                    <text
                      key={g.label}
                      className="z-graph-group"
                      x={g.x}
                      y={g.y}
                      textAnchor="middle"
                    >
                      {g.label}
                    </text>
                  ))}

                  {graph.edges.map((e) => {
                    const a = byId.get(e.a);
                    const b = byId.get(e.b);
                    if (!a || !b) return null;
                    const dim = lit ? !(lit.has(e.a) && lit.has(e.b)) : false;
                    const ux = b.x - a.x;
                    const uy = b.y - a.y;
                    const d = Math.hypot(ux, uy) || 1;
                    return (
                      <path
                        key={e.id}
                        className="z-graph-edge"
                        data-kind={e.kind}
                        data-dim={dim || undefined}
                        // Strength is legible without a legend: two people who
                        // share three rare things get a heavier line than two who
                        // share one common one.
                        strokeWidth={Math.min(1.15 + e.weight * 1.6, 3.4)}
                        markerEnd={e.kind === "discovery" ? "url(#z-arrow)" : undefined}
                        d={edgePath(
                          a.x,
                          a.y,
                          b.x,
                          b.y,
                          boundary(a, ux / d, uy / d),
                          boundary(b, -ux / d, -uy / d)
                        )}
                      />
                    );
                  })}

                  {graph.nodes.map((n) => {
                    const dim =
                      (lit ? !lit.has(n.id) : false) || (matches ? !matches.has(n.id) : false);
                    return (
                      <Node
                        key={n.id}
                        node={n}
                        dim={dim}
                        selected={selected === n.id}
                        // A person is named while they are the thing being looked
                        // at or they connect to it. Naming all of them at once put
                        // twenty overlapping strings on the canvas; naming none
                        // meant hovering told you nothing.
                        named={!!lit && lit.has(n.id)}
                        onHover={setHovered}
                        onSelect={(id) => setSelected((prev) => (prev === id ? null : id))}
                      />
                    );
                  })}
                </g>
              </svg>
            )}

            {/* Canvas controls, bottom-left so they never sit under the panel. */}
            {mounted && (
              <div className="z-graph-dial">
                <button onClick={() => zoom(0.82)} aria-label="Zoom out" title="Zoom out">
                  −
                </button>
                <button onClick={() => zoom(1.22)} aria-label="Zoom in" title="Zoom in">
                  +
                </button>
                <button onClick={recentre} aria-label="Recentre" title="Recentre and clear">
                  ↺
                </button>
              </div>
            )}

            {(selectedCandidate || selectedHub) && (
              <aside className="z-graph-panel">
                {selectedCandidate && selectedNode?.kind === "person" ? (
                  <>
                    <div className="z-row" style={{ alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0 }}>
                        <Link
                          href={`/candidate/${selectedNode.slug}`}
                          className="z-h4 z-person-name"
                        >
                          {selectedCandidate.name}
                        </Link>
                        <p className="z-micro" style={{ marginTop: 2 }}>
                          {selectedCandidate.headline || "No headline"}
                        </p>
                      </div>
                      <span className="z-spacer" />
                      <button
                        className="z-panel-close"
                        onClick={() => setSelected(null)}
                        aria-label="Close"
                      >
                        ×
                      </button>
                    </div>

                    <div
                      className="z-row z-row-wrap"
                      style={{ gap: 6, marginTop: "var(--z-space-4)" }}
                    >
                      <ZScoreBadge candidate={selectedCandidate} />
                      {selectedCandidate.polymath && (
                        <PolymathBadge clusters={selectedCandidate.secondary_archetypes} />
                      )}
                    </div>

                    {(() => {
                      const facts = [
                        selectedCandidate.graduation_year &&
                          `Class of ${selectedCandidate.graduation_year}`,
                        selectedCandidate.school,
                        selectedCandidate.state,
                      ].filter(Boolean);
                      return facts.length > 0 ? (
                        <p className="z-micro" style={{ marginTop: "var(--z-space-3)" }}>
                          {facts.join(" · ")}
                        </p>
                      ) : null;
                    })()}

                    {/* The answer to the question the graph is here to ask. */}
                    <Connections
                      links={graph.connections[selectedNode.slug] ?? []}
                      roster={roster}
                      onFocus={(slug) => setSelected(`p:${slug}`)}
                    />

                    <div
                      className="z-row z-row-wrap"
                      style={{ marginTop: "var(--z-space-5)", gap: "var(--z-space-3)" }}
                    >
                      <MarkControl
                        slug={selectedNode.slug}
                        mark={marks[selectedNode.slug]}
                        onChange={(slug, change) => void mark([slug], change)}
                      />
                      <span className="z-spacer" />
                      <a
                        href={selectedCandidate.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="z-linkish"
                      >
                        LinkedIn
                      </a>
                    </div>
                  </>
                ) : selectedHub ? (
                  <>
                    <div className="z-row" style={{ alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0 }}>
                        <p className="z-label is-quiet">
                          {FACET_NOUN[selectedHub.facet] ?? "Shared"}
                        </p>
                        <p className="z-h4" style={{ marginTop: 2 }}>
                          {selectedHub.label}
                        </p>
                      </div>
                      <span className="z-spacer" />
                      <button
                        className="z-panel-close"
                        onClick={() => setSelected(null)}
                        aria-label="Close"
                      >
                        ×
                      </button>
                    </div>

                    <div className="z-stack" style={{ gap: 0, marginTop: "var(--z-space-4)" }}>
                      {selectedHub.slugs
                        .map((slug) => ({
                          slug,
                          c: queued.find((x) => x.slug === slug),
                        }))
                        .filter((x) => x.c)
                        .sort((a, b) => (b.c!.score ?? 0) - (a.c!.score ?? 0))
                        .map(({ slug, c }) => (
                          <div className="z-breakdown-row" key={slug}>
                            <Link href={`/candidate/${slug}`} className="z-small z-linkish">
                              {c!.name}
                            </Link>
                            <span className="z-num z-micro">{formatSigma(c!.score)}</span>
                          </div>
                        ))}
                    </div>

                    {/* The whole point of a lead. */}
                    {SWEEP_KEY_FOR_FACET[selectedHub.facet] && (
                      <button
                        className="z-btn is-sm z-graph-sweep"
                        onClick={() => sweepFor(selectedHub)}
                      >
                        Sweep for more
                      </button>
                    )}
                  </>
                ) : null}
              </aside>
            )}
          </div>

          {/* Leads. Every thing two or more people share, richest vein first —
              including the ones too broad to draw, which are often the best of
              them. Click to isolate, click again for the sweep. */}
          {graph.hubs.length > 0 && (
            <div className="z-leads z-hide-mobile">
              <span className="z-label is-quiet">Where to look next</span>
              <div className="z-row z-row-wrap" style={{ gap: 6 }}>
                {graph.hubs.map((h) => (
                  <button
                    key={h.id}
                    className="z-lead"
                    data-family={FACET_FAMILY[h.facet] ?? "other"}
                    aria-pressed={selected === h.id}
                    onMouseEnter={() => setHovered(h.id)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => setSelected((prev) => (prev === h.id ? null : h.id))}
                    title={`${h.count} people, ${formatSigma(h.talent)} of talent between them`}
                  >
                    {h.label}
                    <span className="z-lead-n">{h.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Legend. */}
          <div
            className="z-row z-row-wrap z-hide-mobile"
            style={{ marginTop: "var(--z-space-5)", gap: "var(--z-space-5)" }}
          >
            {ARCHETYPES.map((a) => (
              <span key={a.id} className="z-row" style={{ gap: "var(--z-space-2)" }}>
                <span className="z-legend-dot" style={{ background: `var(--z-node-${a.id})` }} />
                <span className="z-small">{a.label}</span>
              </span>
            ))}
            <span className="z-small" style={{ marginLeft: "auto", color: "var(--z-ink-faint)" }}>
              Size is the score
            </span>
          </div>

          {(graph.droppedPeople > 0 || graph.hubsNotDrawn > 0) && (
            <p className="z-micro z-hide-mobile" style={{ marginTop: "var(--z-space-3)" }}>
              {graph.droppedPeople > 0 &&
                `${graph.droppedPeople} lower-scoring ${graph.droppedPeople === 1 ? "person is" : "people are"} not drawn.`}
              {graph.droppedPeople > 0 && graph.hubsNotDrawn > 0 && " "}
              {showTags &&
                graph.hubsNotDrawn > 0 &&
                `${graph.hubsNotDrawn} more ${graph.hubsNotDrawn === 1 ? "hub is" : "hubs are"} in range but past the label cap.`}
            </p>
          )}

          {/* Mobile: a ranked list. A pinch-zoom force graph on a phone is
              unusable, so this degrades to the information the graph conveys. */}
          <div className="z-show-mobile z-stack">
            {queued
              .slice()
              .sort((a, b) => b.score - a.score)
              .map((c) => (
                <div className="z-card" key={c.slug}>
                  <Link href={`/candidate/${c.slug}`} className="z-person-name">
                    {c.name}
                  </Link>
                  <div className="z-row z-row-wrap" style={{ marginTop: 6, gap: 6 }}>
                    <ZScoreBadge candidate={c} />
                    {c.polymath && <PolymathBadge clusters={c.secondary_archetypes} />}
                  </div>
                  <div className="z-row z-row-wrap" style={{ marginTop: 6, gap: 4 }}>
                    <ArchetypeTag archetype={c.archetype} />
                    {c.graduation_year && (
                      <span className="z-micro">Class of {c.graduation_year}</span>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Where a line meets a node, along the unit direction pointing away from it.
 *
 * A person is a disc, so it is just the radius. A hub is a box, so it is whichever
 * of the two faces the ray leaves through. Getting this right is what keeps a
 * discovery arrowhead visible instead of buried under the circle it points at.
 */
function boundary(n: GraphNode, ux: number, uy: number): number {
  if (n.kind === "person") return n.r + 1.5;
  const tx = Math.abs(ux) < 1e-6 ? Infinity : n.w / 2 / Math.abs(ux);
  const ty = Math.abs(uy) < 1e-6 ? Infinity : n.h / 2 / Math.abs(uy);
  return Math.min(tx, ty) + 2;
}

/**
 * Who this person is connected to, and why.
 *
 * Independent of the draw mode on purpose: in Hubs mode the person-to-person edges
 * are not on the canvas, but the question does not stop being worth answering
 * because of how the picture is arranged.
 */
function Connections({
  links,
  roster,
  onFocus,
}: {
  links: { slug: string; reasons: string[]; weight: number }[];
  roster: Record<string, { name?: string } | undefined>;
  onFocus: (slug: string) => void;
}) {
  if (links.length === 0) {
    return (
      <p className="z-micro" style={{ marginTop: "var(--z-space-4)" }}>
        No links to anyone else in the queue.
      </p>
    );
  }
  return (
    <div className="z-stack" style={{ gap: 0, marginTop: "var(--z-space-4)" }}>
      <span className="z-label is-quiet" style={{ marginBottom: 4 }}>
        Connected to
      </span>
      {links.slice(0, 8).map((l) => (
        <button key={l.slug} className="z-conn" onClick={() => onFocus(l.slug)}>
          <span className="z-conn-name">{roster[l.slug]?.name ?? l.slug}</span>
          <span className="z-conn-why">{l.reasons.slice(0, 3).join(" · ")}</span>
        </button>
      ))}
      {links.length > 8 && (
        <span className="z-micro" style={{ marginTop: 4 }}>
          and {links.length - 8} more
        </span>
      )}
    </div>
  );
}

function Node({
  node,
  dim,
  selected,
  named,
  onHover,
  onSelect,
}: {
  node: GraphNode;
  dim: boolean;
  selected: boolean;
  named: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const title =
    node.kind === "person"
      ? `${node.label} ${formatSigma(node.z)} ${archetypeLabel(node.cluster)}${node.enriched ? "" : " (search only)"}`
      : `${node.label} — ${node.count} ${node.count === 1 ? "person" : "people"}`;

  return (
    <g
      data-node
      className="z-graph-node"
      data-kind={node.kind}
      data-dim={dim || undefined}
      data-selected={selected || undefined}
      transform={`translate(${node.x} ${node.y})`}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onSelect(node.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(node.id);
        }
      }}
    >
      <title>{title}</title>
      {node.kind === "person" ? (
        <>
          {/* A soft halo, not a thicker ring: selection should read as attention
              rather than as another category of node. */}
          {selected && <circle className="z-graph-halo" r={node.r + 7} />}
          <circle
            r={node.r}
            fill={`var(--z-node-${node.cluster})`}
            // A ring says Polymath: strong in two or more clusters. Not a separate
            // fill, because the primary cluster is still the label.
            stroke={node.polymath ? "var(--z-navy)" : "var(--z-bg)"}
            strokeWidth={node.polymath ? 2 : 1}
            // Hollow while search-only, matching how the score badge reads.
            strokeDasharray={node.enriched ? undefined : "3 2"}
          />
          {/* Always, for everyone. A node you have to hover to identify is not a
              person on a graph, it is a dot. */}
          <text
            className="z-graph-initials"
            textAnchor="middle"
            dy="0.34em"
            fontSize={Math.max(9, Math.round(node.r * 0.74))}
          >
            {node.initials}
          </text>
          {named && (
            <text className="z-graph-name" textAnchor="middle" y={node.r + 13} paintOrder="stroke">
              {node.label}
            </text>
          )}
        </>
      ) : (
        <>
          <rect
            className="z-graph-chip"
            data-family={FACET_FAMILY[node.facet] ?? "other"}
            x={-node.w / 2}
            y={-node.h / 2}
            width={node.w}
            height={node.h}
            rx={node.h / 2}
          />
          <text className="z-graph-chip-label" x={-node.w / 2 + 11} dy="0.35em">
            {node.label}
          </text>
          <text
            className="z-graph-chip-n"
            x={node.w / 2 - 10}
            dy="0.35em"
            textAnchor="end"
          >
            {node.count}
          </text>
        </>
      )}
    </g>
  );
}
