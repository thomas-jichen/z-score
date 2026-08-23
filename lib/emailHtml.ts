/**
 * The chrome every Z-Score email shares.
 *
 * ── Why the values are literals ───────────────────────────────────────────
 * Everything here duplicates a token from `app/globals.css`, on purpose. An email
 * cannot read a custom property: Outlook's Word engine does not support them, and
 * Gmail strips the `:root` block that would define them. So the palette is written
 * out, once, in `INK` below, and the rule is that these numbers are copied from the
 * `:root` block rather than invented. `npm run check` asserts the important ones
 * still agree.
 *
 * ── What email takes away ─────────────────────────────────────────────────
 * The digest screen was built for this from the start — `app/(app)/digest/page.tsx`
 * says so in its header, its rows are already `<table>`, and `--z-r-email: 4px`
 * exists because Outlook discards pill radius. Four more things it discards, all of
 * which this file works around rather than hopes about:
 *
 *   `border-spacing`   the digest's 8px row gap. Spacer rows instead.
 *   inset shadows      every button in the app has two. Flat fills instead.
 *   `::after`          which is where `.z-score-class` keeps " from search",
 *                      so that string is written into the text here.
 *   `letter-spacing`   ignored outright, so the type sets a little looser there.
 *
 * Flexbox is absent for the same reason, which is why every row below is a table.
 */

/** Copied from the `:root` block in app/globals.css. Keep them in step. */
export const INK = {
  page: "#ffffff",
  surface: "#f6f6fa",
  border: "#e1e4ea",
  borderSoft: "#ebebeb",
  blue: "#2067ff",
  navy: "#000b1c",
  ink: "#000000",
  body: "#363636",
  mid: "#585858",
  faint: "#706e6e",
} as const;

/**
 * The app's stack, with single quotes.
 *
 * globals.css writes `"SF Pro Text"` in double quotes, which is correct in a
 * stylesheet and fatal in an inline style: the first one closes the `style="` HTML
 * attribute, and every declaration after it is discarded. The preview rendered in
 * Times with default blue underlined links, which is what that failure looks like
 * and why the preview exists. CSS treats the two quote characters identically.
 */
export const FONT =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', system-ui, 'Inter', 'Helvetica Neue', Arial, sans-serif";

/** `--z-maxw-email`, declared in globals.css since the redesign and never used until now. */
export const WIDTH = 640;

/** `--z-r-email`. The one deliberate token deviation in the app, and this is why. */
export const RADIUS = 4;

/**
 * Escape for HTML.
 *
 * Everything interpolated below is a person's name, a headline or a credential read
 * off a public profile, which is to say text this app did not write. A name with an
 * ampersand in it is common; a name with a bracket in it is not, but the cost of
 * being wrong once is an email that renders as tag soup.
 */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The outer document.
 *
 * Three nested tables, which is the old shape and still the only reliable one: the
 * outermost paints the page, the middle centres, the innermost holds the 640px
 * column. `role="presentation"` on each so a screen reader reads the content rather
 * than announcing three tables.
 *
 * The `<style>` block carries one media query and nothing else. Gmail supports it,
 * Outlook ignores it, and nothing in the layout depends on it — it only stacks the
 * row cells on a narrow screen, exactly as globals.css:2823 does for the web.
 */
export function shell(input: { title: string; preheader: string; body: string; footer: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(input.title)}</title>
<style>
  @media only screen and (max-width: 620px) {
    .z-stack { display: block !important; width: 100% !important; padding-left: 0 !important; text-align: left !important; }
    .z-stack + .z-stack { padding-top: 12px !important; }
    .z-pad { padding: 16px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${INK.page};">
${preheader(input.preheader)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${INK.page};">
<tr><td align="center" style="padding:32px 16px 48px;">
<table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:${WIDTH}px;max-width:100%;">
<tr><td style="padding-bottom:32px;">
  <span style="font-family:${FONT};font-size:20px;font-weight:800;color:${INK.blue};">Z-Score</span>
</td></tr>
${input.body}
${input.footer}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * The line a mail client shows beside the subject.
 *
 * Left out, clients pull the first text they find, which here is the word "Z-Score"
 * followed by whitespace. Hidden with four properties rather than one because no
 * single one of them works everywhere.
 */
function preheader(text: string): string {
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(text)}</div>`;
}

/** The eyebrow and the title. Two text levels, which is the whole block. */
export function heading(eyebrow: string, title: string): string {
  return `<tr><td style="padding-bottom:32px;">
  <p style="margin:0 0 8px;font-family:${FONT};font-size:14px;font-weight:600;line-height:1.4;color:${INK.blue};">${esc(eyebrow)}</p>
  <h1 style="margin:0;font-family:${FONT};font-size:34px;font-weight:700;line-height:1.1;color:${INK.ink};">${esc(title)}</h1>
</td></tr>`;
}

/**
 * One card.
 *
 * The digest screen gets its 8px row gap from `border-spacing`, which Outlook drops,
 * so each card carries its own spacer row underneath instead. Same result, and it
 * survives.
 */
export function card(inner: string): string {
  return `<tr><td class="z-pad" style="background:${INK.surface};border-radius:${RADIUS}px;padding:20px 24px;">
${inner}
</td></tr>
<tr><td style="height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>`;
}

/**
 * A button.
 *
 * Flat, because both of the app's button shadows are `inset` and Outlook drops
 * those. The secondary treatment is the one the digest already uses at the foot of
 * the page, so it is the one that belongs here.
 */
export function button(href: string, label: string): string {
  return `<a href="${esc(href)}" style="display:inline-block;font-family:${FONT};font-size:14px;font-weight:600;line-height:1.2;color:${INK.ink};background:${INK.page};border:1px solid ${INK.border};border-radius:${RADIUS}px;padding:10px 20px;text-decoration:none;">${esc(label)}</a>`;
}

/**
 * The foot of every email: one action, then who this went to and how to stop it.
 *
 * No list-unsubscribe header and no tracking pixel. This is internal mail to three
 * colleagues who each typed their own address into the digest screen, and the cadence
 * control there is the off switch, so the honest thing is to link to it.
 *
 * It points at /digest rather than /agent because that is where the control lives,
 * and because the digest screen is this email: somebody who followed the link to
 * turn it off lands on the thing they were about to stop receiving.
 */
export function footer(input: { origin: string; cta?: { href: string; label: string }; why: string }): string {
  const cta = input.cta
    ? `<tr><td style="padding-top:16px;padding-bottom:24px;">${button(input.cta.href, input.cta.label)}</td></tr>`
    : "";
  return `${cta}<tr><td style="padding-top:24px;border-top:1px solid ${INK.borderSoft};">
  <p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.5;color:${INK.faint};">
    ${esc(input.why)} <a href="${esc(input.origin)}/digest" style="color:${INK.faint};">Change how often you get these.</a>
  </p>
</td></tr>`;
}

/**
 * Plural without the "1 people" tell.
 *
 * The same helper the Agent screen grew for the same reason, which is that a count
 * beside a noun is the most common place careless copy shows.
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
