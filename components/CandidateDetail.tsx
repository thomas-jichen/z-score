"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { allTags } from "@/lib/tags";
import { ARCHETYPES, archetypeLabel, formatSigma, type Archetype } from "@/lib/zscore";
import { CLUSTER_CALIBRATION, POLYMATH_SIGMA } from "@/lib/clusters";
import {
  ArchetypeTag,
  Button,
  Card,
  EmptyState,
  MarkControl,
  PolymathBadge,
  TagChip,
  ZScoreBadge,
  ZScoreBreakdown,
} from "@/components/primitives";

/**
 * One person, from the shared roster.
 *
 * The score is the headline and the name is second, because the score is what
 * this screen is for. Below that: why they scored what they did, what is actually
 * on their profile, and how they were found.
 */
export function CandidateDetail({ slug }: { slug: string }) {
  const { roster, bySlug, marks, team, candidates, loading, mark, setCluster, editTerms, enrich, analyze, analyzing, taggerEnabled, job } =
    useApp();

  const [addingTag, setAddingTag] = useState(false);
  const [draftTag, setDraftTag] = useState("");

  const person = roster[slug];
  const c = bySlug.get(slug);

  const tags = useMemo(
    () => (person ? allTags(person, team.taxonomy) : []),
    [person, team.taxonomy]
  );

  // Everyone this person led to, which is the rabbit hole the tool is for.
  const ledTo = useMemo(
    () => candidates.filter((o) => o.slug !== slug && o.discovery.some((h) => h.slug === slug)),
    [candidates, slug]
  );

  if (!person || !c) {
    return (
      <div className="z-page">
        <Link href="/queue" className="z-linkish">
          Back to queue
        </Link>
        <div style={{ marginTop: "var(--z-space-10)" }}>
          <EmptyState
            title={loading ? "Loading." : "No one by that name."}
            hint={
              loading
                ? undefined
                : "They may have been deleted, or dropped when the roster was trimmed."
            }
          />
        </div>
      </div>
    );
  }

  const headline = [...c.signals].sort((a, b) => b.deviation - a.deviation).slice(0, 3);
  const rest = c.signals.filter((s) => !headline.includes(s));
  const isSeed = c.discovery.length === 1 && c.discovery[0].kind === "seed";
  const e = person.enriched;

  const details = [
    ["School", c.school],
    ["Class of", c.graduation_year],
    ["Location", c.location],
    e?.connectionsCount !== undefined ? ["Connections", String(e.connectionsCount)] : undefined,
    e?.followerCount !== undefined ? ["Followers", String(e.followerCount)] : undefined,
    // Joining LinkedIn at 14 is itself a signal, so the date is worth showing.
    e?.registeredAt ? ["On LinkedIn since", e.registeredAt.slice(0, 4)] : undefined,
  ].filter(Boolean) as [string, string][];

  const clustersCleared = (Object.entries(c.cluster_scores) as [Archetype, number][])
    .filter(([, z]) => z >= POLYMATH_SIGMA)
    .sort((a, b) => b[1] - a[1]);

  return (
    <div className="z-page">
      <Link href="/queue" className="z-linkish">
        Back to queue
      </Link>

      {/* Hero. The score is the headline, the name is second. */}
      <div style={{ margin: "var(--z-space-8) 0 var(--z-space-12)" }}>
        <ZScoreBadge candidate={c} display />
        <h1 className="z-h1" style={{ marginTop: "var(--z-space-4)" }}>
          {c.name}
        </h1>
        <p className="z-body" style={{ marginTop: "var(--z-space-2)", maxWidth: "58ch" }}>
          {c.headline || (c.enriched ? "No headline on the profile." : "Not enriched yet.")}
        </p>
        <div className="z-row z-row-wrap" style={{ marginTop: "var(--z-space-6)", gap: "var(--z-space-3)" }}>
          <ArchetypeTag archetype={c.archetype} href={`/queue?archetype=${c.archetype}`} />
          {c.polymath && <PolymathBadge clusters={c.secondary_archetypes} />}
          <select
            className="z-input"
            style={{ padding: "5px 8px", fontSize: "var(--z-fs-micro)", width: "auto" }}
            value={person.clusterOverride ?? "auto"}
            onChange={(ev) =>
              void setCluster(slug, ev.target.value === "auto" ? null : (ev.target.value as Archetype))
            }
            aria-label="Cluster"
            title="Override the computed cluster"
          >
            <option value="auto">Automatic{person.clusterOverride ? "" : ` (${archetypeLabel(c.archetype)})`}</option>
            {ARCHETYPES.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          <span className="z-spacer" />
          <MarkControl slug={slug} mark={marks[slug]} onChange={(s, change) => void mark([s], change)} />
        </div>

        {!c.enriched && (
          <div className="z-banner" style={{ marginTop: "var(--z-space-6)" }}>
            Known from search results only, so the score reads whatever the snippet said.
            <span className="z-spacer" />
            <Button
              size="sm"
              onClick={() => void enrich([slug], { kind: "seed", hop: 0 })}
              disabled={job.phase === "running"}
            >
              {job.phase === "running" ? "Enriching" : "Enrich, about $0.004"}
            </Button>
          </div>
        )}
      </div>

      <div
        className="z-detail-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.5fr) minmax(0, 1fr)",
          gap: "var(--z-space-12)",
          alignItems: "start",
        }}
      >
        <div>
          {/* Why they surfaced. The terms that carry the score. */}
          {headline.length > 0 ? (
            <div className="z-stack" style={{ gap: "var(--z-space-5)" }}>
              {headline.map((s) => (
                <div
                  key={s.id}
                  className="z-row"
                  style={{ alignItems: "baseline", gap: "var(--z-space-5)" }}
                >
                  <span className="z-h3" style={{ flex: 1, minWidth: 0 }}>
                    {s.label}
                  </span>
                  <span className="z-h4 z-num" style={{ color: "var(--z-blue)" }}>
                    {formatSigma(s.deviation)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="z-body">
              Nothing in the taxonomy matched this profile. Worth a look anyway, or worth adding a
              term on the{" "}
              <Link href="/taxonomy" className="z-linkish">
                taxonomy screen
              </Link>
              .
            </p>
          )}

          {rest.length > 0 && (
            <details className="z-disclosure z-section-gap">
              <summary>
                Everything else
                <span className="z-count">{rest.length}</span>
              </summary>
              <div className="z-disclosure-body">
                {rest.map((s) => (
                  <div className="z-breakdown-row" key={s.id}>
                    <span className="z-breakdown-term">
                      {s.label}
                      <span className="z-micro" style={{ display: "block" }}>
                        from {s.source}
                      </span>
                    </span>
                    <span className="z-breakdown-dev" data-negative={s.deviation < 0}>
                      {formatSigma(s.deviation)}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Tags, with their origin visible, and editable by hand. */}
          <div className="z-section-gap">
            <div className="z-col-head">
              <p className="z-label is-quiet">Tags</p>
              <span className="z-spacer" />
              {taggerEnabled && (
                <button
                  className="z-linkish"
                  onClick={() => void analyze([slug], true)}
                  disabled={analyzing}
                  title="Ask the tagger to read this profile again"
                >
                  {analyzing ? "Reading" : "Re-analyze"}
                </button>
              )}
              <button className="z-linkish" onClick={() => setAddingTag(true)}>
                Add
              </button>
            </div>

            {addingTag && (
              <div className="z-row" style={{ gap: "var(--z-space-2)", marginBottom: "var(--z-space-3)" }}>
                <input
                  className="z-input"
                  autoFocus
                  placeholder="Davidson Fellow"
                  value={draftTag}
                  onChange={(ev) => setDraftTag(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" && draftTag.trim()) {
                      void editTerms(slug, { add: [draftTag.trim()] });
                      setDraftTag("");
                      setAddingTag(false);
                    }
                    if (ev.key === "Escape") {
                      setDraftTag("");
                      setAddingTag(false);
                    }
                  }}
                  style={{ maxWidth: 240, padding: "6px 10px", fontSize: "var(--z-fs-small)" }}
                />
                <button
                  className="z-linkish"
                  onClick={() => {
                    setDraftTag("");
                    setAddingTag(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            )}

            {tags.length === 0 ? (
              <p className="z-small">No tags yet.</p>
            ) : (
              <div className="z-row z-row-wrap" style={{ gap: 4 }}>
                {tags.map((t) => (
                  <TagChip
                    key={`${t.kind}-${t.label}`}
                    tag={t}
                    onRemove={
                      // Only the ones a person put there, or the model did, can be
                      // taken away. A taxonomy match is a fact about the text.
                      t.origin === "llm" || t.origin === "attribute"
                        ? () => void editTerms(slug, { remove: [t.label] })
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
          </div>

          {/* Real profile sections, only present once enriched. */}
          {e && (
            <div className="z-section-gap z-stack" style={{ gap: "var(--z-space-6)" }}>
              <Section title="Honors" items={e.honors.map((h) => [h.title, h.issuedBy])} />
              <Section title="Projects" items={e.projects.map((p) => [p.title, p.description])} />
              <Section
                title="Experience"
                items={e.experience.map((x) => [
                  x.title,
                  [x.company, x.startYear ? String(x.startYear) : ""].filter(Boolean).join(", "),
                ])}
              />
              <Section
                title="Education"
                items={e.educations.map((x) => [
                  x.school,
                  [x.degree, x.endYear ? `class of ${x.endYear}` : ""].filter(Boolean).join(", "),
                ])}
              />
              <Section title="Publications" items={e.publications.map((p) => [p, ""])} />
              <Section title="Volunteering" items={e.volunteering.map((v) => [v.role, v.organization])} />
            </div>
          )}

          {/* Discovery trace. Every hop navigates. This is the rabbit hole. */}
          <div className="z-section-gap">
            <p className="z-label is-quiet">How we got here</p>
            {isSeed ? (
              <>
                <p className="z-body">
                  Seed profile. Hand verified rather than discovered, and one of the starting points
                  the sweep expands from.
                </p>
                {ledTo.length > 0 && (
                  <>
                    <p className="z-small" style={{ margin: "var(--z-space-5) 0 var(--z-space-3)" }}>
                      Led to {ledTo.length} {ledTo.length === 1 ? "person" : "people"}
                    </p>
                    <div className="z-row z-row-wrap" style={{ gap: "var(--z-space-2)" }}>
                      {ledTo.map((d) => (
                        <Link key={d.slug} href={`/candidate/${d.slug}`} className="z-pill">
                          {d.name}
                        </Link>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : (
              <ol className="z-trace">
                {c.discovery.map((h, i) => (
                  <li key={i} className="z-row" style={{ gap: "var(--z-space-2)" }}>
                    {i > 0 && <span style={{ color: "var(--z-divider)" }}>→</span>}
                    {h.slug && h.slug !== c.slug ? (
                      <Link href={`/candidate/${h.slug}`} className="z-pill">
                        {h.label}
                      </Link>
                    ) : (
                      <span className="z-pill">
                        {h.kind === "people_also_viewed" ? "People also viewed" : h.label}
                      </span>
                    )}
                  </li>
                ))}
                <li className="z-row" style={{ gap: "var(--z-space-2)" }}>
                  <span style={{ color: "var(--z-divider)" }}>→</span>
                  <span className="z-pill is-active">{c.name}</span>
                </li>
              </ol>
            )}
          </div>
        </div>

        <div className="z-stack" style={{ gap: "var(--z-space-6)" }}>
          <Card size="lg">
            <div className="z-row" style={{ marginBottom: "var(--z-space-5)" }}>
              <div>
                <p className="z-small">In {archetypeLabel(c.archetype)}</p>
                <p className="z-h3 z-num">{formatSigma(c.z_score_archetype)}</p>
              </div>
              <div style={{ marginLeft: "auto", textAlign: "right" }}>
                <p className="z-small">Whole profile</p>
                <p className="z-h3 z-num" style={{ color: "var(--z-blue)" }}>
                  {formatSigma(c.z_score_normalized)}
                </p>
              </div>
            </div>

            <ZScoreBreakdown candidate={c} />

            {clustersCleared.length > 1 && (
              <div style={{ marginTop: "var(--z-space-5)" }}>
                <p className="z-label is-quiet" style={{ marginBottom: "var(--z-space-2)" }}>
                  Clusters cleared
                </p>
                {clustersCleared.map(([cluster, z]) => (
                  <div className="z-breakdown-row" key={cluster}>
                    <span className="z-micro">{archetypeLabel(cluster)}</span>
                    <span className="z-micro z-num">{formatSigma(z)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* The score is reproducible, and saying so is the point. */}
            <p className="z-micro" style={{ marginTop: "var(--z-space-4)" }}>
              Scored against fixed calibration, not against whoever else has been enriched, so this
              number does not move as the queue grows. Cluster mean is{" "}
              {CLUSTER_CALIBRATION[c.archetype].mu.toFixed(1)}.
            </p>
          </Card>

          <div>
            {details.map(([k, v]) => (
              <div className="z-breakdown-row" key={k}>
                <span className="z-small">{k}</span>
                <span className="z-small" style={{ color: "var(--z-ink)" }}>
                  {v}
                </span>
              </div>
            ))}
            <a
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              className="z-btn is-secondary is-sm"
              style={{ marginTop: "var(--z-space-5)", width: "100%" }}
            >
              Open LinkedIn
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, items }: { title: string; items: (string | undefined)[][] }) {
  const rows = items.filter((r) => r[0]);
  if (rows.length === 0) return null;

  return (
    <div>
      <p className="z-label is-quiet" style={{ marginBottom: "var(--z-space-3)" }}>
        {title}
      </p>
      {rows.slice(0, 12).map((r, i) => (
        <div className="z-breakdown-row" key={i}>
          <span className="z-breakdown-term">{r[0]}</span>
          <span className="z-small" style={{ color: "var(--z-ink-faint)", textAlign: "right" }}>
            {r[1] ?? ""}
          </span>
        </div>
      ))}
      {rows.length > 12 && <p className="z-micro">and {rows.length - 12} more</p>}
    </div>
  );
}
