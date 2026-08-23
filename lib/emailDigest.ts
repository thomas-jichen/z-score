import type { Campaign } from "./campaign";
import type { ReportPerson } from "./campaignRun";
import { FONT, INK, RADIUS, card, esc, footer, heading, plural, shell } from "./emailHtml";
import { archetypeLabel, dominantSignals, formatSigma, type Candidate } from "./zscore";

/**
 * The two emails, as pure functions.
 *
 * No I/O and no clock, so both are testable with nothing mocked, which is the point:
 * an email is the one surface nobody looks at before it reaches somebody else. What
 * `npm run check` can assert here it should.
 *
 * ── The layout is not a new design ────────────────────────────────────────
 * `app/(app)/digest/page.tsx` is already the specification. It renders rows as
 * `<table>`, drops to a 4px radius, and its header comment says it is "the one that
 * may ship as email". So this mirrors it cell for cell rather than inventing a
 * second way to show a candidate, and it reuses `dominantSignals` and `formatSigma`
 * directly so the email and the screen cannot disagree about a number.
 *
 * ── The copy rules apply here too ─────────────────────────────────────────
 * Sentence case throughout, including the subject. No middle dot and no em dash in
 * anything rendered — `DESIGN_LANGUAGE.md` calls the middle dot the one most easily
 * reintroduced because it looks tidy in a list of three short facts, and a subject
 * line is exactly that shape of temptation. `npm run check` asserts their absence
 * over the real output of both templates, since there is no lint for it.
 */

export type Rendered = { subject: string; html: string; text: string };

/* ── The queue digest ───────────────────────────────────────────────────── */

export function renderQueueDigest(input: {
  candidates: Candidate[];
  queueTotal: number;
  knownCount: number;
  /** The reader's last visit, so a person found since then is marked. Null on a first send. */
  newSince: string | null;
  origin: string;
  cadence: "daily" | "weekly";
}): Rendered {
  const { candidates, queueTotal, knownCount, newSince, origin, cadence } = input;
  const isNew = (at: string) => Boolean(newSince && at > newSince);
  const newCount = candidates.filter((c) => isNew(c.surfaced_at)).length;

  /**
   * The eyebrow answers what changed, which is the question the email exists to
   * answer. The screen falls back to "Top 10 of 47 in the queue" because you asked
   * to be there; an email arrived unbidden and has to justify itself in one line.
   */
  const eyebrow =
    candidates.length === 0
      ? "Nothing in the queue yet"
      : newCount > 0
        ? `${plural(newCount, "new person", "new people")} since the last one`
        : `Top ${candidates.length} of ${queueTotal} in the queue`;

  const subject =
    candidates.length === 0
      ? "Nothing in the queue yet"
      : newCount > 0
        ? `${plural(newCount, "new person", "new people")} in the queue`
        : `${candidates[0].name} leads the queue at ${formatSigma(candidates[0].score)}`;

  const rows = candidates.map((c) => card(personRow(c, origin, isNew(c.surfaced_at)))).join("\n");

  const empty = card(
    `<p style="margin:0;font-family:${FONT};font-size:20px;font-weight:600;color:${INK.ink};">Nobody in the queue.</p>
<p style="margin:4px 0 0;font-family:${FONT};font-size:14px;line-height:1.4;color:${INK.faint};">Run a sweep, or start a campaign and let it find people for you.</p>`
  );

  const known =
    knownCount > 0
      ? ` ${plural(knownCount, "person", "people")} you already knew ${knownCount === 1 ? "is" : "are"} not counted.`
      : "";

  const html = shell({
    title: subject,
    preheader: subject,
    body: heading(eyebrow, "Fresh talent, ranked.") + (candidates.length === 0 ? empty : rows),
    footer: footer({
      origin,
      cta: { href: `${origin}/queue`, label: "See the whole queue" },
      why: `You get this ${cadence}.${known}`,
    }),
  });

  return { subject, html, text: digestText(candidates, eyebrow, origin, known) };
}

/**
 * One candidate, three cells, exactly as the digest screen lays them out.
 *
 * The third cell on the screen is the triage control, which has no meaning in an
 * inbox, so the email gives that width back to the signals and makes the name the
 * only thing to click.
 */
function personRow(c: Candidate, origin: string, fresh: boolean): string {
  const top = dominantSignals(c, 2);

  /**
   * `.z-score-class::after` is where the screen keeps " from search" for a person
   * nobody has paid to enrich. Generated content does not survive an email client,
   * so it is written out here, and the sigma goes grey the same way.
   */
  const sigmaColour = c.enriched ? INK.blue : INK.mid;
  const cluster = archetypeLabel(c.archetype) + (c.enriched ? "" : " from search");

  const signals = top.length
    ? top
        .map(
          (s) =>
            `<div style="font-family:${FONT};font-size:14px;line-height:1.4;color:${INK.body};padding-bottom:4px;">${esc(
              s.label
            )} <span style="color:${INK.faint};">${formatSigma(s.points)}</span></div>`
        )
        .join("")
    : `<div style="font-family:${FONT};font-size:14px;line-height:1.4;color:${INK.faint};">${
        c.enriched ? "Nothing in the taxonomy matched." : "Not enriched yet, so only the search text was read."
      }</div>`;

  const newMark = fresh
    ? ` <span style="font-family:${FONT};font-size:13px;font-weight:500;color:${INK.blue};">new</span>`
    : "";

  const polymath = c.polymath
    ? `<div style="padding-top:6px;"><span style="display:inline-block;font-family:${FONT};font-size:13px;font-weight:500;line-height:1.15;color:${INK.blue};border:1px solid ${INK.blue};border-radius:${RADIUS}px;padding:5px 10px;">Polymath</span></div>`
    : "";

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
<tr>
<td class="z-stack" valign="top" style="vertical-align:top;">
  <a href="${esc(origin)}/candidate/${esc(c.slug)}" style="font-family:${FONT};font-size:20px;font-weight:600;line-height:1.3;color:${INK.ink};text-decoration:none;">${esc(c.name)}</a>${newMark}
  <div style="padding-top:6px;font-family:${FONT};font-size:16px;">
    <span style="font-weight:600;color:${sigmaColour};">${formatSigma(c.score)}</span>
    <span style="font-size:14px;font-weight:500;color:${INK.faint};">${esc(cluster)}</span>
  </div>
  ${polymath}
</td>
<td class="z-stack" valign="top" width="46%" style="vertical-align:top;width:46%;padding-left:32px;">
  ${signals}
</td>
</tr>
</table>`;
}

function digestText(candidates: Candidate[], eyebrow: string, origin: string, known: string): string {
  const lines = candidates.map((c) => {
    const top = dominantSignals(c, 2)
      .map((s) => `${s.label} ${formatSigma(s.points)}`)
      .join(", ");
    return `${formatSigma(c.score)}  ${c.name}, ${archetypeLabel(c.archetype)}${
      top ? `\n     ${top}` : ""
    }\n     ${origin}/candidate/${c.slug}`;
  });
  return [
    "Fresh talent, ranked.",
    eyebrow,
    "",
    ...(lines.length ? lines : ["Nobody in the queue."]),
    "",
    `See the whole queue: ${origin}/queue`,
    known.trim(),
    `Change how often you get these: ${origin}/digest`,
  ]
    .filter(Boolean)
    .join("\n");
}

/* ── The campaign report ────────────────────────────────────────────────── */

export function renderCampaignReport(input: {
  campaign: Campaign;
  people: ReportPerson[];
  origin: string;
}): Rendered {
  const { campaign: c, people, origin } = input;

  /**
   * The subject is a sentence about what happened, because that is what makes it
   * worth opening. "[Z-Score] Campaign Complete" is the shape to avoid: it names the
   * system rather than the finding, and it is title case.
   */
  const subject =
    c.foundCount === 0
      ? `${c.name} finished without finding anyone`
      : `${c.name} found ${plural(c.foundCount, "person", "people")}`;

  /**
   * The same sentence the Agent screen writes under a campaign row, so somebody
   * reading both is reading one voice. `finishedReason` is already phrased to follow
   * the word "it", which is why it reads on from "Ran" here.
   */
  const spend = `$${c.spentUsd.toFixed(2)} of $${c.settings.budgetUsd.toFixed(2)}`;
  /**
   * The spend, then why it stopped, and the day count only when the reason does not
   * already carry it. The first version read "Ran 2 days, $0.04 of $0.30. It ran its
   * full 2 days." — the reason is phrased to follow the word "it", and the commonest
   * reason is the day count, so saying both says it twice.
   */
  const eyebrow = c.finishedReason
    ? `${spend}. It ${c.finishedReason}.`
    : `Ran ${plural(c.day, "day")}, ${spend}.`;

  const rows = people.map((p) => card(reportRow(p, origin))).join("\n");

  const empty = card(
    `<p style="margin:0;font-family:${FONT};font-size:20px;font-weight:600;color:${INK.ink};">It found nobody.</p>
<p style="margin:4px 0 0;font-family:${FONT};font-size:14px;line-height:1.4;color:${INK.faint};">Widen the selection or add queries of your own, then raise the day count to start it again.</p>`
  );

  const html = shell({
    title: subject,
    preheader: eyebrow,
    body: heading(eyebrow, subject) + (people.length === 0 ? empty : rows),
    footer: footer({
      origin,
      cta: { href: `${origin}/agent`, label: "Open the campaign" },
      why: "You get this when one of your campaigns finishes.",
    }),
  });

  return { subject, html, text: reportText(c, people, eyebrow, origin) };
}

function reportRow(p: ReportPerson, origin: string): string {
  const sigmaColour = p.enriched ? INK.blue : INK.mid;
  const cluster = archetypeLabel(p.archetype) + (p.enriched ? "" : " from search");

  const signals = p.signals.length
    ? p.signals
        .slice(0, 3)
        .map(
          (s) =>
            `<div style="font-family:${FONT};font-size:14px;line-height:1.4;color:${INK.body};padding-bottom:4px;">${esc(
              s.label
            )} <span style="color:${INK.faint};">${formatSigma(s.points)}</span></div>`
        )
        .join("")
    : `<div style="font-family:${FONT};font-size:14px;line-height:1.4;color:${INK.faint};">${
        p.evicted ? "No longer in the roster, so this is the row as it was found." : "Nothing in the taxonomy matched."
      }</div>`;

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
<tr>
<td class="z-stack" valign="top" style="vertical-align:top;">
  <a href="${esc(origin)}/candidate/${esc(p.slug)}" style="font-family:${FONT};font-size:20px;font-weight:600;line-height:1.3;color:${INK.ink};text-decoration:none;">${esc(p.name)}</a>
  <div style="padding-top:6px;font-family:${FONT};font-size:16px;">
    <span style="font-weight:600;color:${sigmaColour};">${formatSigma(p.score)}</span>
    <span style="font-size:14px;font-weight:500;color:${INK.faint};">${esc(cluster)}</span>
  </div>
  ${
    p.headline
      ? `<div style="padding-top:6px;font-family:${FONT};font-size:13px;line-height:1.4;color:${INK.faint};">${esc(
          p.headline
        )}</div>`
      : ""
  }
</td>
<td class="z-stack" valign="top" width="46%" style="vertical-align:top;width:46%;padding-left:32px;">
  ${signals}
</td>
</tr>
</table>`;
}

function reportText(c: Campaign, people: ReportPerson[], eyebrow: string, origin: string): string {
  const lines = people.map(
    (p) =>
      `${formatSigma(p.score)}  ${p.name}, ${archetypeLabel(p.archetype)}\n     ${origin}/candidate/${p.slug}`
  );
  return [
    c.name,
    eyebrow,
    "",
    ...(lines.length ? lines : ["It found nobody."]),
    "",
    `Open the campaign: ${origin}/agent`,
  ].join("\n");
}
