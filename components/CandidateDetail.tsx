"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useApp } from "@/components/AppState";
import { heldOrErased, hopAfter, neighborsFrom } from "@/lib/people";
import { extractTags } from "@/lib/extract";
import { allTags, schoolStateLookup } from "@/lib/tags";
import {
  ARCHETYPES,
  archetypeLabel,
  formatSigma,
  type Archetype,
  type Candidate,
} from "@/lib/zscore";
import {
  ArchetypeTag,
  Avatar,
  Button,
  Card,
  EmptyState,
  MarkControl,
  PolymathBadge,
  SignalWhy,
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
  const { roster, bySlug, marks, team, candidates, loading, mark, setCluster, editTerms, enrich, addNeighbors, analyze, analyzing, taggerEnabled, job } =
    useApp();

  const [addingTag, setAddingTag] = useState(false);
  const [draftTag, setDraftTag] = useState("");
  const [queueing, setQueueing] = useState<string | null>(null);

  const person = roster[slug];
  const c = bySlug.get(slug);

  /**
   * This person's People Also Viewed sidebar, minus anyone already in the roster.
   * Persisted with the enrichment, so it is here for good rather than only in the
   * session where the run happened.
   */
  const alsoViewed = useMemo(
    () => (person ? neighborsFrom(person, heldOrErased(roster, team.deleted)) : []),
    [person, roster, team.deleted]
  );

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

  const headline = [...c.signals].sort((a, b) => b.points - a.points).slice(0, 3);
  const rest = c.signals.filter((s) => !headline.includes(s));
  const isSeed = c.discovery.length === 1 && c.discovery[0].kind === "seed";
  const e = person.enriched;

  /**
   * Where they are now and where they are from, as two rows.
   *
   * They are different facts and frequently different answers — a Stanford student
   * from Georgia is both — and the home state is the one that groups someone with
   * the cohort they actually came up through. Marked as inferred, because it is
   * deduced from the high school rather than stated on the profile.
   */
  const geo = extractTags(person, schoolStateLookup(team.taxonomy)).tags;
  const homeState = geo.find((t) => t.facet === "homestate")?.label;

  const details = [
    ["School", c.school],
    ["Class of", c.graduation_year],
    ["Location", c.location],
    homeState ? ["Home state", `${homeState}, inferred`] : undefined,
    e?.connectionsCount !== undefined ? ["Connections", String(e.connectionsCount)] : undefined,
    e?.followerCount !== undefined ? ["Followers", String(e.followerCount)] : undefined,
    // Joining LinkedIn at 14 is itself a signal, so the date is worth showing.
    e?.registeredAt ? ["On LinkedIn since", e.registeredAt.slice(0, 4)] : undefined,
    // A row whose value is absent is dropped, not rendered as a dangling label. Half
    // the roster has no knowable class year, and "Class of" followed by nothing reads
    // as a bug rather than as an unknown.
  ].filter((row): row is [string, string] => Boolean(row && row[1]));

  // Was "clears +0.5σ". Now "reaches the polymath threshold in points", set in
  // the taxonomy, because there is no sigma left to clear.
  const clustersCleared = (Object.entries(c.cluster_scores) as [Archetype, number][])
    .filter(([, points]) => points >= team.taxonomy.polymathPoints)
    .sort((a, b) => b[1] - a[1]);

  return (
    <div className="z-page">
      <Link href="/queue" className="z-linkish">
        Back to queue
      </Link>

      {/* Hero. The score is the headline, the name is second. */}
      <div className="z-hero" style={{ margin: "var(--z-space-8) 0 var(--z-space-12)" }}>
        {/*
          The face, or the initials, the same way the queue does it.
          
          This page had no avatar at all, so every profile looked photoless whether it
          was or not. Showing nothing when there is no photo was the first attempt and
          it was worse: the queue shows "JL" and the profile showed a blank, so the one
          screen where you go to look at somebody was the one that appeared broken.
          Initials at 72px say "no picture" out loud, which is the truthful answer for
          the two people whose headshot LinkedIn will not serve to a scraper.
        */}
        <HeroFace candidate={c} />
        <div style={{ minWidth: 0 }}>
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
                    {formatSigma(s.points)}
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
                      <SignalWhy signal={s} />
                    </span>
                    <span className="z-breakdown-dev" data-negative={s.points < 0}>
                      {formatSigma(s.points)}
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
              /* `z-tagwall`: on a phone twenty-five chips each carrying a remove
                 control is the densest block in the app, so it gets a capped
                 height and its own scroll instead of the whole screen. */
              <div className="z-row z-row-wrap z-tagwall" style={{ gap: 4 }}>
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

          {/* Where this person leads next. The sidebar came free with their
              enrichment, so looking costs nothing and queueing costs nothing
              either. Enriching happens from the queue, where the spend is
              already the subject of the screen. */}
          {alsoViewed.length > 0 && (
            <details className="z-disclosure z-section-gap">
              <summary>
                People also viewed
                <span className="z-count">{alsoViewed.length}</span>
              </summary>
              <div className="z-disclosure-body">
                <p className="z-small" style={{ marginBottom: "var(--z-space-4)", maxWidth: "62ch" }}>
                  Who browsers looked at in the same session as {c.name}. A co-view,
                  not a judgement of similarity, and nobody here is in the roster yet.
                </p>
                <div className="z-stack" style={{ gap: "var(--z-space-4)" }}>
                  {alsoViewed.map((n) => (
                    <div key={n.slug} className="z-row">
                      <span style={{ minWidth: 0 }}>
                        <a
                          href={n.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="z-person-name"
                        >
                          {n.name}
                        </a>
                        <span className="z-person-sub">
                          {[n.position, n.year].filter(Boolean).join(", ")}
                        </span>
                      </span>
                      <span className="z-spacer" />
                      <button
                        className="z-linkish"
                        disabled={queueing === n.slug}
                        onClick={async () => {
                          setQueueing(n.slug);
                          await addNeighbors([n], hopAfter(person));
                          setQueueing(null);
                        }}
                      >
                        {queueing === n.slug ? "Adding" : "Add to queue"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          )}
        </div>

        <div className="z-stack" style={{ gap: "var(--z-space-6)" }}>
          <Card size="lg">
            <div className="z-row" style={{ marginBottom: "var(--z-space-5)" }}>
              <div>
                <p className="z-small">In {archetypeLabel(c.archetype)}</p>
                <p className="z-h3 z-num">{formatSigma(c.archetype_score)}</p>
              </div>
              <div style={{ marginLeft: "auto", textAlign: "right" }}>
                <p className="z-small">Whole profile</p>
                <p className="z-h3 z-num" style={{ color: "var(--z-blue)" }}>
                  {formatSigma(c.score)}
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

            {/* The score is reproducible, and saying so is the point. The old copy
                here claimed a fixed mean and a cluster mean, which stopped being
                true when the score became a sum. */}
            <p className="z-micro" style={{ marginTop: "var(--z-space-4)" }}>
              The total is the sum of the rows above, nothing more. It does not move as the queue
              grows, and every weight is editable on the{" "}
              <Link href="/taxonomy" className="z-linkish">
                taxonomy screen
              </Link>
              .
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
        /* `is-prose`: both halves are sentences, so on a phone they stack rather
           than each taking half the width and wrapping to three lines. */
        <div className="z-breakdown-row is-prose" key={i}>
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

/* ── The face ───────────────────────────────────────────────────────────── */

/**
 * The picture, and a way to supply one when the vendor will not.
 *
 * LinkedIn lets somebody restrict who sees their photo, and to LinkedIn a scraper is
 * nobody. Two of thirty-four profiles come back with a banner, company logos, school
 * logos, even the headshots of people they follow — and no headshot of their own.
 * Retrying does not fix it and no vendor gets past it without running a session
 * inside that person's network, so the answer is to let a human hand the image over.
 *
 * Three ways in, because which one feels natural depends on where the picture is:
 * paste it if it is on the clipboard, drop it if it is a file, click if neither. All
 * three land in the same place.
 */
function HeroFace({ candidate }: { candidate: Candidate }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [bust, setBust] = useState(0);
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const shown = candidate.has_photo || bust > 0;

  async function take(file: File | null | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    setBusy(true);
    setSaid(null);
    try {
      const blob = await square(file);
      const res = await fetch(`/api/photo/${encodeURIComponent(candidate.slug)}`, {
        method: "PUT",
        headers: { "Content-Type": blob.type },
        body: blob,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setSaid(data.error ?? "That did not save.");
      /**
       * Cache-busted rather than reloaded. The image is served with a long
       * `Cache-Control`, which is right for bytes that never change and wrong for the
       * one moment they do, so the new copy has to be asked for by a different URL.
       */
      else setBust(Date.now());
    } catch {
      setSaid("Could not read that image.");
    }
    setBusy(false);
  }

  return (
    <div
      className="z-hero-face"
      data-over={over || undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void take(e.dataTransfer.files?.[0]);
      }}
      onPaste={(e) => {
        const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
        if (item) void take(item.getAsFile());
      }}
      // Focusable so a paste has somewhere to land, and the whole block is the target.
      tabIndex={0}
      aria-label="Profile photo. Paste or drop an image to set one."
    >
      <Avatar name={candidate.name} slug={candidate.slug} photo={shown} size="lg" bust={bust} />
      <input
        ref={pick}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void take(e.target.files?.[0])}
      />
      <button className="z-linkish" onClick={() => pick.current?.click()} disabled={busy}>
        {busy ? "Saving" : shown ? "Replace" : "Add a photo"}
      </button>
      {said && <span className="z-micro">{said}</span>}
    </div>
  );
}

/**
 * A 200px square, made in the browser.
 *
 * The same size the vendor supplies, so one cache holds one kind of thing. Doing it
 * here rather than server-side is what makes "drop any image" work at all: a photo off
 * a phone is several megabytes and would bounce straight off the size cap, and being
 * told to resize a file first is not an answer.
 */
async function square(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = 200;
  canvas.height = 200;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  // Centre crop, matching the `object-fit: cover` the avatar already uses, so what
  // lands is what the picker showed.
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 200, 200);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no blob"))), "image/jpeg", 0.9)
  );
}
