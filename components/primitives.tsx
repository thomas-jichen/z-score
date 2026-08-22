"use client";

import Link from "next/link";
import { useState } from "react";
import {
  archetypeLabel,
  dominantSignals,
  formatSigma,
  type Archetype,
  type Candidate,
  type Signal,
} from "@/lib/zscore";
import type { PersonMark, PersonStatus } from "@/lib/people";
import type { Tag } from "@/lib/tags";

/* ── Button ─ derives from zfellows .new-button ─────────────────────────── */

export function Button({
  variant = "primary",
  size,
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm";
}) {
  const v = variant === "secondary" ? " is-secondary" : variant === "ghost" ? " is-ghost" : "";
  return <button className={`z-btn${v}${size === "sm" ? " is-sm" : ""} ${className}`} {...rest} />;
}

/* ── Card ─ derives from .faqs_wrapper / .investors_logo-wrapper ────────── */

export function Card({
  size,
  tone,
  className = "",
  children,
}: {
  size?: "lg";
  tone?: "plain" | "blue";
  className?: string;
  children: React.ReactNode;
}) {
  const t = tone === "plain" ? " is-plain" : tone === "blue" ? " is-blue" : "";
  return <div className={`z-card${size === "lg" ? " is-lg" : ""}${t} ${className}`}>{children}</div>;
}

/* ── Pill ─ derives from .blog-publish-wrap ─────────────────────────────── */

export function Pill({
  active,
  as = "span",
  className = "",
  children,
  ...rest
}: {
  active?: boolean;
  as?: "span" | "button";
  className?: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  const cls = `z-pill${active ? " is-active" : ""} ${className}`;
  if (as === "button") {
    return (
      <button type="button" className={cls} {...rest}>
        {children}
      </button>
    );
  }
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}

/**
 * ArchetypeTag — navigational. Clicking filters the queue to that cluster.
 * Cluster is carried by a 2px left rule from the sourced values, not by six
 * invented hues. See DESIGN_TOKENS.md §archetype conflict.
 */
export function ArchetypeTag({ archetype, href }: { archetype: Archetype; href?: string }) {
  const content = archetypeLabel(archetype);
  const cls = "z-pill z-archetype";
  if (href) {
    return (
      <Link href={href} className={cls} data-archetype={archetype}>
        {content}
      </Link>
    );
  }
  return (
    <span className={cls} data-archetype={archetype}>
      {content}
    </span>
  );
}

/**
 * Polymath is a badge, not a cluster. A cluster is a reference class you can
 * take a mean of; "strong in two or more" is not a population, so it reads as an
 * annotation on the primary label rather than replacing it.
 */
export function PolymathBadge({ clusters }: { clusters?: Archetype[] }) {
  const title = clusters?.length
    ? `Also scores in ${clusters.map(archetypeLabel).join(", ")}`
    : "Scores in two or more clusters";
  return (
    <span className="z-badge-poly" title={title}>
      Polymath
    </span>
  );
}

/* ── Segmented control ─ derives from .content-tab-link ─────────────────── */

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="z-segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className="z-segment"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ── Z-Score badge ──────────────────────────────────────────────────────── */

export function ZScoreBadge({
  candidate,
  display,
  showClass = true,
}: {
  candidate: Candidate;
  display?: boolean;
  showClass?: boolean;
}) {
  const score = candidate.score;
  return (
    <span
      className={`z-score${display ? " is-display" : ""}`}
      // Hollow while a person is known from search results alone. The score is
      // computed the same way with no discount; this says how much was read.
      data-thin={!candidate.enriched || undefined}
      title={candidate.enriched ? undefined : "Scored from search results only. Not enriched yet."}
    >
      <span className="z-score-sigma">{formatSigma(score)}</span>
      {showClass && <span className="z-score-class">{archetypeLabel(candidate.archetype)}</span>}
    </span>
  );
}

/**
 * ScoreBar — the one wholly new visual form; no marketing-site analogue.
 *
 * A total is now a sum with no negative range in practice, so the bar fills from
 * the left rather than growing either side of a mean. `max` is the taxonomy's
 * "exceptional" threshold, so a full bar means "clears the top band" instead of
 * the old fixed 3.5σ, which would have pinned every profile at 100% once scores
 * moved into the tens.
 */
export function DeviationBar({ z, max }: { z: number; max: number }) {
  const pct = Math.min(Math.max(z, 0) / Math.max(max, 0.1), 1);
  return (
    <span className="z-dev" aria-hidden="true">
      <span className="z-dev-bar" style={{ left: 0, width: `${pct * 100}%` }} />
    </span>
  );
}

/* ── Breakdown — the rows add up to the total ────────────────────────────── */

/**
 * Why a signal is there, in one line under its name.
 *
 * The quote is the whole point. Working out why Philip Meng carried a Benchmark tag
 * — it was the word "benchmark" in one of his own paper titles — took a script and a
 * dump of the roster, because the matcher tested a regex and threw the match away.
 * The words that fired are now kept, so a wrong tag is arguable on sight.
 *
 * The section name is the fallback, not the preference: it is a weaker answer to the
 * same question, and for a tag read from a structured field it is the only one there
 * is. The rung leads when there is one, because it is the explanation for a weight
 * that looks lower than the taxonomy says it should be.
 */
export function SignalWhy({ signal }: { signal: Signal }) {
  const why = signal.evidence
    ? `${signal.tier ? `${signal.tier}, ` : ""}\u201c${signal.evidence}\u201d`
    : `from ${signal.source}`;
  return (
    <span className="z-micro" style={{ display: "block" }}>
      {why}
    </span>
  );
}

export function ZScoreBreakdown({ candidate }: { candidate: Candidate }) {
  const [open, setOpen] = useState(false);
  const top = dominantSignals(candidate, 3);
  const rest = candidate.signals.filter((s) => !top.includes(s));
  const shown: Signal[] = open ? [...top, ...rest] : top;

  return (
    <div>
      {shown.map((s) => (
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
      {rest.length > 0 && (
        <button className="z-linkish" style={{ marginTop: 12 }} onClick={() => setOpen(!open)}>
          {open ? "Show less" : `${rest.length} more ${rest.length === 1 ? "term" : "terms"}`}
        </button>
      )}
    </div>
  );
}

/* ── Marks ──────────────────────────────────────────────────────────────── */

export type MarkChange = { status?: PersonStatus; pinned?: boolean };

/**
 * Three controls, three distinct verbs.
 *
 * "Interested" used to be one of these, which was redundant: being in the queue
 * is the interest signal. So the third slot does something the pipeline actually
 * needs — pinning — and rejecting became a real removal rather than a flag
 * nothing read.
 *
 * Known is kept separate from rejected on purpose. "This sweep surfaced eight
 * people Cory already rates" is evidence the tool works, and folding it into
 * delete throws that away.
 */
export function MarkControl({
  slug,
  mark,
  onChange,
  compact,
}: {
  slug: string;
  mark?: PersonMark;
  onChange: (slug: string, change: MarkChange) => void;
  compact?: boolean;
}) {
  const status = mark?.status ?? "queued";
  const pinned = Boolean(mark?.pinned);

  const act = (e: React.MouseEvent, change: MarkChange) => {
    e.preventDefault();
    e.stopPropagation();
    onChange(slug, change);
  };

  return (
    <span className={`z-mark${compact ? " is-compact" : ""}`} role="group" aria-label="Triage">
      <button
        type="button"
        className="z-mark-btn"
        data-mark="pin"
        aria-pressed={pinned}
        aria-label={pinned ? "Unpin" : "Pin to the top"}
        title={pinned ? "Unpin" : "Pin to the top"}
        onClick={(e) => act(e, { pinned: !pinned })}
      >
        ★
      </button>
      <button
        type="button"
        className="z-mark-btn"
        data-mark="known"
        aria-pressed={status === "known"}
        aria-label={status === "known" ? "Back to the queue" : "Already know them"}
        title={status === "known" ? "Back to the queue" : "Already know them"}
        onClick={(e) => act(e, { status: status === "known" ? "queued" : "known" })}
      >
        ◆
      </button>
      <button
        type="button"
        className="z-mark-btn"
        data-mark="reject"
        aria-pressed={status === "rejected"}
        aria-label={status === "rejected" ? "Back to the queue" : "Remove from the queue"}
        title={
          status === "rejected"
            ? "Back to the queue"
            : "Remove from the queue, and from future sweeps"
        }
        onClick={(e) => act(e, { status: status === "rejected" ? "queued" : "rejected" })}
      >
        ×
      </button>
    </span>
  );
}

/* ── Tags ───────────────────────────────────────────────────────────────── */

/**
 * An unconfirmed tag is one the search query implies but the person's own text
 * does not show — an OR group never reports which branch matched. It is rendered
 * dimmed and struck because it is a reason they were looked at, not a fact about
 * them, and it contributes nothing to the score.
 */
export function TagChip({ tag, onRemove }: { tag: Tag; onRemove?: () => void }) {
  const title = tag.confirmed
    ? tag.origin === "llm"
      ? "Read off the profile by the tagger. Promote it on the taxonomy screen to make it score."
      : undefined
    : "Implied by the search query, but not found in this person's own text. Does not score.";

  return (
    <span
      className="z-tag"
      data-kind={tag.kind}
      data-origin={tag.origin}
      data-unconfirmed={!tag.confirmed || undefined}
      title={title}
    >
      {/* The label needs its own box. `text-overflow` cannot apply to a bare text
          node inside an inline-flex, so a long tag was cut mid-word with no ellipsis
          to say so — "Electrical Engineering ar". */}
      <span className="z-tag-label">{tag.label}</span>
      {onRemove && (
        <button
          type="button"
          className="z-tag-x"
          onClick={onRemove}
          aria-label={`Remove ${tag.label}`}
        >
          ×
        </button>
      )}
    </span>
  );
}

/* ── Person cell ────────────────────────────────────────────────────────── */

export function Avatar({ name, size }: { name: string; size?: "lg" }) {
  // Square + grayscale, matching zfellows' image treatment (30/30 hero images).
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
  return (
    <span
      className={`z-avatar${size === "lg" ? " is-lg" : ""}`}
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        fontSize: size === "lg" ? 22 : 12,
        color: "var(--z-ink-mid)",
      }}
    >
      {initials}
    </span>
  );
}

export function PersonCell({
  candidate,
  sub,
  year,
}: {
  candidate: Candidate;
  sub?: React.ReactNode;
  /**
   * Class year, set beside the name rather than in a column of its own.
   *
   * Half a roster has no knowable year — nothing on their education rows is dated —
   * so a dedicated column was mostly an empty stripe with a heading over it. Next to
   * the name it simply is not there when it is not known.
   */
  year?: string;
}) {
  return (
    <span className="z-person">
      <Avatar name={candidate.name} />
      <span style={{ minWidth: 0 }}>
        <span className="z-person-head">
          <Link href={`/candidate/${candidate.slug}`} className="z-person-name">
            {candidate.name}
          </Link>
          {year && <span className="z-person-year">{year}</span>}
        </span>
        <span className="z-person-sub">{sub ?? candidate.headline}</span>
      </span>
    </span>
  );
}

/* ── Empty state ────────────────────────────────────────────────────────── */

export function EmptyState({ title, hint }: { title: string; hint?: React.ReactNode }) {
  return (
    <div className="z-empty">
      <p className="z-h4">{title}</p>
      {hint && <p className="z-small">{hint}</p>}
    </div>
  );
}
