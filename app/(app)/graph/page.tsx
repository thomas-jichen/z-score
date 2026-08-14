"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/components/AppState";
import {
  DEFAULT_MAX_HOLDERS,
  DEFAULT_MIN_HOLDERS,
  EDGE_SOURCES,
  GROUP_BY,
  NODE_CAP,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  buildGraph,
  neighborsOf,
  type EdgeSource,
  type GraphNode,
  type GroupBy,
} from "@/lib/graph";
import { ARCHETYPES, archetypeLabel, formatSigma } from "@/lib/zscore";
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
 * Light canvas on --z-surface, which is the tone the rest of the app already
 * uses. Person node size is the z-score; tag node size is how many people hold
 * that tag. Cluster is carried by fill and Polymath by a ring.
 *
 * Rendered client-only behind a mounted flag. The layout is deterministic but it
 * is still floating-point trigonometry, and Node and the browser are permitted to
 * disagree in the last digit — which shows up as a hydration mismatch rather than
 * as anything visible. Computing it only on the client removes the whole class of
 * bug instead of rounding around it.
 */

const SOURCE_LABEL: Record<EdgeSource, string> = {
  program: "Programs",
  school: "School",
  year: "Class year",
  state: "State",
  discovery: "Discovery",
};

const GROUP_LABEL: Record<GroupBy, string> = {
  cluster: "Cluster",
  year: "Class year",
  school: "School",
  state: "State",
};

export default function GraphPage() {
  const { candidates, roster, team, marks, queue, mark, loading } = useApp();

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [sources, setSources] = useState<EdgeSource[]>(["program", "school", "discovery"]);
  const [groupBy, setGroupBy] = useState<GroupBy>("cluster");
  const [showTags, setShowTags] = useState(true);
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

  const focus = selected ?? hovered;
  const lit = useMemo(
    () => (focus ? neighborsOf(graph.edges, focus) : null),
    [focus, graph.edges]
  );

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return null;
    return new Set(
      graph.nodes.filter((n) => n.label.toLowerCase().includes(term)).map((n) => n.id)
    );
  }, [search, graph.nodes]);

  const selectedNode = selected ? byId.get(selected) : undefined;
  const selectedCandidate =
    selectedNode?.kind === "person"
      ? queued.find((c) => c.slug === selectedNode.slug)
      : undefined;

  function toggleSource(s: EdgeSource) {
    setSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setView((v) => ({ ...v, k: Math.min(Math.max(v.k * (e.deltaY < 0 ? 1.12 : 0.89), 0.4), 4) }));
  }, []);

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

  const reset = () => {
    setView({ x: 0, y: 0, k: 1 });
    setSelected(null);
    setSearch("");
  };

  const empty = queue.length === 0;

  return (
    <div className="z-page">
      <div className="z-page-head">
        <p className="z-label">
          {graph.nodes.filter((n) => n.kind === "person").length} people
          {showTags ? `, ${graph.nodes.filter((n) => n.kind === "tag").length} tags` : ""},{" "}
          {graph.edges.length} {graph.edges.length === 1 ? "link" : "links"}
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
          {/* Controls. Two rows, because six groups on one line wraps badly. */}
          <div className="z-stack z-hide-mobile" style={{ gap: "var(--z-space-3)", marginBottom: "var(--z-space-5)" }}>
            <div className="z-row z-row-wrap" style={{ gap: "var(--z-space-2)" }}>
              <span className="z-label is-quiet" style={{ marginRight: 4 }}>
                Group by
              </span>
              {GROUP_BY.map((g) => (
                <Pill key={g} as="button" active={groupBy === g} onClick={() => setGroupBy(g)}>
                  {GROUP_LABEL[g]}
                </Pill>
              ))}
              <span className="z-spacer" />
              <input
                className="z-input"
                placeholder="Find a person or tag"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ maxWidth: 220, padding: "6px 10px", fontSize: "var(--z-fs-small)" }}
                aria-label="Search the graph"
              />
            </div>

            <div className="z-row z-row-wrap" style={{ gap: "var(--z-space-2)" }}>
              <span className="z-label is-quiet" style={{ marginRight: 4 }}>
                Links
              </span>
              {EDGE_SOURCES.map((s) => (
                <Pill
                  key={s}
                  as="button"
                  active={sources.includes(s)}
                  onClick={() => toggleSource(s)}
                  title={
                    s === "discovery"
                      ? "Who was found on whose People Also Viewed. A direct link, not an inferred one."
                      : undefined
                  }
                >
                  {SOURCE_LABEL[s]}
                </Pill>
              ))}
              <span className="z-spacer" />
              <Pill as="button" active={showTags} onClick={() => setShowTags(!showTags)}>
                {showTags ? "Tag nodes" : "People only"}
              </Pill>
              <label className="z-row z-micro" style={{ gap: 6 }}>
                Hide tags above
                <input
                  type="range"
                  min={2}
                  max={30}
                  step={1}
                  value={maxHolders}
                  onChange={(e) => setMaxHolders(Number(e.target.value))}
                  style={{ width: 90, accentColor: "var(--z-blue)" }}
                  aria-label="Maximum people per tag"
                />
                <span className="z-num">{maxHolders}</span>
              </label>
              <button className="z-linkish" onClick={reset}>
                Reset
              </button>
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
                onWheel={onWheel}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
                role="img"
                aria-label={`Relationship graph of ${queued.length} people`}
              >
                <g transform={`translate(${VIEW_WIDTH / 2} ${VIEW_HEIGHT / 2}) scale(${view.k}) translate(${-VIEW_WIDTH / 2 + view.x} ${-VIEW_HEIGHT / 2 + view.y})`}>
                  {graph.edges.map((e) => {
                    const a = byId.get(e.a);
                    const b = byId.get(e.b);
                    if (!a || !b) return null;
                    const dim = lit ? !(lit.has(e.a) && lit.has(e.b)) : false;
                    return (
                      <line
                        key={e.id}
                        className="z-graph-edge"
                        data-kind={e.kind}
                        data-dim={dim || undefined}
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
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
                        onHover={setHovered}
                        onSelect={(id) => setSelected((prev) => (prev === id ? null : id))}
                      />
                    );
                  })}
                </g>
              </svg>
            )}

            {selectedNode && (
              <aside className="z-graph-panel">
                {selectedNode.kind === "person" && selectedCandidate ? (
                  <>
                    <div className="z-row" style={{ alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0 }}>
                        <Link href={`/candidate/${selectedNode.slug}`} className="z-h4 z-person-name">
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

                    <div className="z-row z-row-wrap" style={{ gap: 6, marginTop: "var(--z-space-4)" }}>
                      <ZScoreBadge candidate={selectedCandidate} />
                      {selectedCandidate.polymath && (
                        <PolymathBadge clusters={selectedCandidate.secondary_archetypes} />
                      )}
                    </div>

                    <div className="z-stack" style={{ gap: 2, marginTop: "var(--z-space-4)" }}>
                      {[
                        ["Class of", selectedCandidate.graduation_year],
                        ["School", selectedCandidate.school],
                        ["State", selectedCandidate.state],
                      ]
                        .filter(([, v]) => v)
                        .map(([k, v]) => (
                          <div className="z-breakdown-row" key={k as string}>
                            <span className="z-micro">{k}</span>
                            <span className="z-micro" style={{ color: "var(--z-ink)" }}>
                              {v}
                            </span>
                          </div>
                        ))}
                    </div>

                    <div className="z-row z-row-wrap" style={{ marginTop: "var(--z-space-5)", gap: "var(--z-space-3)" }}>
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
                ) : selectedNode.kind === "tag" ? (
                  <>
                    <div className="z-row" style={{ alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0 }}>
                        <p className="z-h4">{selectedNode.label}</p>
                        <p className="z-micro" style={{ marginTop: 2 }}>
                          {selectedNode.count} {selectedNode.count === 1 ? "person" : "people"} share
                          this
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
                    <div className="z-stack" style={{ gap: 4, marginTop: "var(--z-space-4)" }}>
                      {graph.edges
                        .filter((e) => e.a === selectedNode.id || e.b === selectedNode.id)
                        .map((e) => {
                          const other = byId.get(e.a === selectedNode.id ? e.b : e.a);
                          if (!other || other.kind !== "person") return null;
                          return (
                            <Link
                              key={e.id}
                              href={`/candidate/${other.slug}`}
                              className="z-small z-linkish"
                            >
                              {other.label}
                            </Link>
                          );
                        })}
                    </div>
                  </>
                ) : null}
              </aside>
            )}
          </div>

          {/* Legend, plus an honest account of what was left out. */}
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
              Node size is the z-score
            </span>
          </div>

          {(graph.droppedPeople > 0 || graph.tooCommon.length > 0) && (
            <p className="z-micro z-hide-mobile" style={{ marginTop: "var(--z-space-3)" }}>
              {graph.droppedPeople > 0 &&
                `${graph.droppedPeople} lower-scoring ${graph.droppedPeople === 1 ? "person is" : "people are"} not drawn, so the picture stays readable. `}
              {graph.tooCommon.length > 0 &&
                `Held by more than ${maxHolders} people and therefore treated as background: ${graph.tooCommon
                  .slice(0, 4)
                  .map((t) => `${t.label} (${t.count})`)
                  .join(", ")}${graph.tooCommon.length > 4 ? `, and ${graph.tooCommon.length - 4} more` : ""}.`}
            </p>
          )}

          {/* Mobile: a ranked list. A pinch-zoom force graph on a phone is
              unusable, so this degrades to the information the graph conveys. */}
          <div className="z-show-mobile z-stack">
            {queued
              .slice()
              .sort((a, b) => b.z_score_normalized - a.z_score_normalized)
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
                    {c.graduation_year && <span className="z-micro">Class of {c.graduation_year}</span>}
                  </div>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

function Node({
  node,
  dim,
  selected,
  onHover,
  onSelect,
}: {
  node: GraphNode;
  dim: boolean;
  selected: boolean;
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
          <circle
            r={node.r}
            fill={`var(--z-node-${node.cluster})`}
            // A ring says Polymath: strong in two or more clusters. Not a
            // separate fill, because the primary cluster is still the label.
            stroke={node.polymath ? "var(--z-navy)" : "var(--z-bg)"}
            strokeWidth={node.polymath ? 2 : 1}
            // Hollow while search-only, matching how the score badge reads.
            strokeDasharray={node.enriched ? undefined : "3 2"}
          />
          {node.r >= 11 && (
            <text className="z-graph-initials" textAnchor="middle" dy="0.34em" fontSize={node.r * 0.8}>
              {node.initials}
            </text>
          )}
        </>
      ) : (
        <>
          <circle r={node.r} className="z-graph-tagdot" />
          <text className="z-graph-taglabel" textAnchor="middle" y={-node.r - 4}>
            {node.label}
          </text>
        </>
      )}
    </g>
  );
}
