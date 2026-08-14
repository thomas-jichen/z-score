# Z-Score — Redesign Plan

Companion to [`DESIGN_TOKENS.md`](./DESIGN_TOKENS.md) (sourced token set) and
[`UI_AUDIT.md`](./UI_AUDIT.md) (pre-redesign state). This file is the implementation spec.

**Scope, as approved:** build the design system, restyle the existing sweep screen, and build
all five briefed screens as fully-designed, fully-interactive UI against a typed mock fixture.
Scoring math and LLM extraction stay stubbed behind a feature flag. The digest is a web route
with an email-safe layout structure.

---

## 1. Design system

Full token set lives in `DESIGN_TOKENS.md` and ships as CSS custom properties in
`app/globals.css`. No Tailwind — the app has none today, and adding it to reproduce a
hand-extracted token set would mean retheming stock utilities rather than writing the system
directly. Plain CSS with custom properties is the shorter path and avoids the "shadcn/Tailwind
stock styling" anti-pattern by construction.

Summary of what ships:

- **Colour** — 16 tokens, every one sourced from zfellows.com's `:root` or computed styles
- **Type** — system stack (SF Pro via `-apple-system`, Inter fallback); 9-step scale, every
  size and tracking value present in the source CSS
- **Radius** — 7 tokens, pills through circles, plus one email-safe override
- **Shadow** — 5 tokens including the signature inset blue button glow
- **Motion** — 3 durations (`.2s`/`.3s`/`.4s`), default ease, no custom bezier in source
- **Spacing** — `0.25rem` grid preserved; section rhythm halved from the marketing scale

**Dark mode is removed.** The brief specifies light theme matching zfellows.com, and a computed
scan found dark used there only as a card treatment, never a section. The existing dark-mode
token block is deleted rather than retained unused.

---

## 2. Component inventory

Each component names the zfellows.com rule it derives from. Components with no precedent are
called out in §6 rather than quietly invented.

| Component | Derives from | Notes |
|---|---|---|
| `Button` | `.new-button` | Pill, inset blue glow. Variants: primary, secondary (white fill), ghost |
| `Card` | `.faqs_wrapper` / `.investors_logo-wrapper` | `--z-surface` fill, 12px or 20px radius |
| `Pill` | `.blog-publish-wrap` | Base tag primitive |
| `ZScoreBadge` | `.blog-publish-wrap` | Sigma value + archetype, magnitude ramp applied |
| `ZScoreBreakdown` | `.faqs_wrapper` accordion | Expandable; dominant terms shown by default |
| `ArchetypeTag` | `.blog-publish-wrap` | Navigational — filters the queue on click |
| `SegmentedControl` | `.content-tab-link` | Archetype and score-band filters |
| `Nav` | `.new-navbar_link` | Top horizontal, no sidebar |
| `RatingControl` | `.pagination-no-item` | Three circular states |
| `DeviationBar` | — | See §6 |
| `DataTable` | `.new-mentor_content-wrapper` | See §6 |
| `GraphCanvas` | `.pagination-no-item` | See §6 |

---

## 3. Screens

**Navigation.** zfellows.com uses a top horizontal nav: left wordmark, centre links, right pill
CTA. The app inherits exactly that — `Z-Score` left, `Digest · Queue · Graph · Taxonomy`
centre, `Run sweep` pill right. Explicitly not sidebar-plus-topbar.

### 3.1 Digest — `/digest`

Primary surface, email-safe. Single centred column at `max-width: 640px`, table-based row grid,
no flex/grid dependency in the core layout. Cream page, `--z-surface` cards.

Header eyebrow in the marketing idiom: `12 NEW · THIS WEEK`. Each row carries a grayscale square
avatar, name, `ZScoreBadge`, the top two signals, and a `RatingControl`.

Token deviation, per `DESIGN_TOKENS.md`: `--z-r-email: 4px` and flat fills replace pill radius
and inset shadows, which Outlook drops.

### 3.2 Candidate queue — `/queue`

The density screen. `SegmentedControl` for archetype and score band; grad-year and location as
`Pill` filters. Rows separated by `1px --z-border`; header row `--z-surface`. No zebra striping
— no precedent for it, and it reads as dashboard default.

Each row: avatar, name + headline, `ZScoreBadge`, `DeviationBar`, archetype tags, grad year,
`RatingControl`. Mobile collapses to stacked cards with filters in a bottom sheet.

### 3.3 Candidate detail — `/candidate/[slug]` — the most important screen

Built around how Cory actually screens: find someone interesting, look at what they did, follow
the thread to the next person.

- **Hierarchy, not a field grid.** `+2.4σ · Olympiad` at display size. Top signals at h2.
  Biographical facts demoted to `small` / `--z-ink-faint`. `IMO Silver 2025` sits above
  `Location: Austin, TX` by an order of visual magnitude.
- **Discovery trace is a clickable chain.** `seed: Ada Chen → People Also Viewed → this person`
  — every hop is a link that navigates to that person. This is the rabbit hole made native.
- **`ZScoreBreakdown` is expandable**, defaulting to the two or three dominant terms, expressed
  as deviations (`IMO Silver 2025  +1.8σ`) never raw points.
- **Archetype tags navigate** to the queue filtered to that cluster.

### 3.4 Graph view — `/graph`

Desktop-primary. Canvas on `--z-surface-dark` `#33363b` — the one sourced dark surface. Nodes
extend `.pagination-no-item` (circular, `3.18rem`); edges `--z-divider`. Node size scales with
`z_score_normalized`; seeds ring in `--z-blue`.

**Mobile degrades to a ranked adjacency list, not pan-and-zoom.** A pinch-zoom force graph on a
phone is unusable; the brief asks for graceful degradation, not parity.

### 3.5 Taxonomy admin — `/taxonomy`

Desktop-primary. Two panes: a weighted program table with inline-editable weights, and an
"unmatched but notable" review queue with promote/dismiss. Reuses `DataTable`.

Note this needs a **weighted** taxonomy, which the existing search taxonomy is not — hence the
`searchTaxonomy` rename in §4.

### 3.6 Rating

`RatingControl`, three genuinely distinct states — `interested`, `not_interested`,
`already_know`. "Already know them" is separate signal and never collapses into "not
interested". One tap or click, optimistic, no modal, no navigation away. Mounted in queue rows,
detail header, and digest rows. Backend stubbed behind `ZSCORE_RATING_ENABLED`.

### 3.7 Voice

Direct, warm, slightly irreverent, matching "We are your first believer." / "When in doubt,
apply. We're all winging it :)" / "Internapalooza is so back."

- Empty queue — *"Nothing new yet. The sweep runs Sunday — check back then :)"*
- Zero filter results — *"No one matched. Loosen a filter and try again."*
- Loading — *"Reading profiles…"*
- Error — *"That didn't work. <reason>"* — states what happened, never apologises vaguely

No corporate SaaS copy anywhere.

---

## 4. Rename map

See `UI_AUDIT.md` for the full table with reasons. Summary:

`lib/taxonomy.ts` → `lib/searchTaxonomy.ts`; `Term` → `SearchTerm`; `termToFragment` →
`searchTermToFragment`; package `talent-sweep` → `z-score`; title → `Z-Score`;
`sweep_session` → `zscore_session`; all env vars gain the `ZSCORE_` prefix.

New schema, fixed now: `z_score` (never `score` or `rating`), `z_score_archetype`,
`z_score_normalized`, `Archetype`, `Candidate`, `Signal`, `DiscoveryHop`, `Rating`.

Unchanged: `Hit` (a SERP result is not a candidate; both coexist), `/api/sweep`, `Shard`.

---

## 5. Migration order

1. **Tokens + renames** — rewrite `globals.css` as the token layer; apply every rename; update
   `.env.example` and `README.md`. Touches everything, depends on nothing.
2. **Primitives** — the component table in §2.
3. **Restyle the sweep screen** onto the primitives. Proves the system against real data before
   any mock screen exists.
4. **Types + fixture** — `Candidate`, `Archetype`, `z_score*`; ~40 mock candidates spanning all
   archetype clusters and the full sigma range.
5. **Queue → Detail → Digest → Taxonomy → Graph.** Detail precedes digest because the digest
   reuses the candidate row and badge. Graph last: most novel, least precedent.

---

## 6. Open questions and conflicts

Where the references disagree, or where a UI need has no reference precedent at all.

### 6.1 Archetype colour — the sharpest conflict

The brief wants nodes and tags "coloured by archetype" across 5+ clusters. zfellows.com ships
exactly one accent plus one light blue. Five invented hues would break "every colour ships with
a source."

**Resolution:** encode archetype by position and weight, not hue proliferation. All archetype
tags share `--z-surface` and differ by a 2px left rule drawn from the five sourced values
(`#2067ff`, `#4aaeff`, `#000b1c`, `#585858`, `#d4d4d4`). Graph nodes differ by ring style and
size rather than fill.

If five genuinely distinct hues are wanted, that needs an authorised palette extension. Flagged,
not silently resolved.

### 6.2 Components with no precedent

Neither reference contains a data table, a filterable list, or a network graph. Each is built by
extending a **named** source rule so the derivation is auditable:

| Need | Extends | How |
|---|---|---|
| `DataTable` | `.new-mentor_content-wrapper` (`#ebebeb`, radius 0) + `.faqs_wrapper` card | Header row on `--z-surface`; body rows separated by `1px --z-border`; no striping; radius only on the outer container |
| Filter rail | `.content-tab-link` (`radius 6.4375rem`, inactive `opacity .7`) | Segmented control for archetype and score band; `Pill` for multi-select facets |
| `GraphCanvas` | `.pagination-no-item` (`radius 100%`, `3.18rem`, `transition all .3s`) | Nodes are that circle scaled by score; edges `--z-divider` at 1px |
| `DeviationBar` | — **genuinely new** | No marketing-site analogue exists. Built from tokens only: 1px `--z-divider` baseline, mean at a fixed x-offset, bar in `--z-blue`. Flagged as the one wholly new visual form |

### 6.3 Remaining

- **Digest token deviation** — 4px radius and flat fills for email safety (documented).
- **Four Phase 0 UNKNOWNs** — nav sticky behaviour, section-level dark, mobile computed values,
  hover/focus states. See `DESIGN_TOKENS.md`. Mobile values verified at 390px before mobile
  layouts finalise.
- **Scoring math is not specified and is not invented.** `z_score_archetype` and
  `z_score_normalized` exist in schema and fixture with plausible values; computation stays
  stubbed behind `ZSCORE_SCORING_ENABLED`. Real math is a separate decision.

---

## 7. Verification

- `npm run check` — 46 existing assertions must still pass
- `npm run build:check` — isolated dist dir; cannot clobber a running dev server
- Every screen screenshotted at **1440×900 and 390×812**; mobile is first-class
- Live Serper sweep confirming the restyled sweep screen still returns and dedupes
- AA contrast on the score magnitude ramp against `--z-cream`; `#706e6e` on `#fffdf3` is the
  weakest pair
- Digest rendered at 640px with flex/grid disabled, confirming the email-safe structure holds
