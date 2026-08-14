# Z-Score — Design Tokens

Every value carries a source. Nothing here is invented; where a value could not be
determined it is marked **UNKNOWN** and the fallback decision is stated explicitly.

## Sources

| ID | What |
|---|---|
| **A** | `https://cdn.prod.website-files.com/638f3177988a2191df92b80b/css/z-fellows-micro1.webflow.shared.d0f6b0877.min.css` (129,572 bytes) — zfellows.com's Webflow stylesheet. Frequency counts below are `grep` counts over this file. |
| **B** | `getComputedStyle` on `https://www.zfellows.com/` at 1440×900 |
| **C** | `getComputedStyle` on `https://internapalooza.com/` — **secondary**, used only for typographic scale cross-check and voice |

zfellows.com is authoritative. Any conflict resolves to A/B over C.

---

## Color

All from the `:root` custom-property block in Source A unless noted.

| Token | Value | Source |
|---|---|---|
| `--z-bg` | `#ffffff` | **C** internapalooza.com `body` background = `rgb(255,255,255)`. Chosen over zfellows' cream `#fffdf3` at the client's direction; the secondary reference supplies the value. |
| `--z-blue` | `#2067ff` | A `--_new-base---core-colors--primary-color-2067ff` and `--primary-blue`; 10 hex occurrences; B `.new-button` background |
| `--z-blue-light` | `#4aaeff` | A `--light-blue`; 9 occurrences |
| `--z-blue-glow` | `#75a9ff` | A `.new-button` inset shadow colour |
| `--z-navy` | `#000b1c` | A `--dark-blue` |
| `--z-surface` | `#f6f6fa` | A `--off-white`. Swapped from the warm cream `#f7f4e9` when the page went white, because a warm card on a pure-white page reads as discolouration rather than as a surface. |
| `--z-surface-blue` | `#eaf1fb` | B — 5 cards at 12px radius |
| `--z-surface-dark` | `#33363b` | B — 20 cards at 12px radius |
| `--z-border` | `#e1e4ea` | A `--_new-base---neutral-colors--cool-grey-e1e4ea` |
| `--z-border-soft` | `#ebebeb` | A `--lighter-grey-ebebeb`; B `.new-mentor_content-wrapper` background |
| `--z-divider` | `#d4d4d4` | A `--_new-base---neutral-colors--light-grey-d4d4d4` |
| `--z-ink` | `#000000` | B `body` colour |
| `--z-ink-nav` | `#222222` | B `.new-navbar_link` colour |
| `--z-ink-body` | `#363636` | A `--black-grey-363636`; B `p` = `rgb(54,54,54)` |
| `--z-ink-mid` | `#585858` | A `--mid-grey-585858` |
| `--z-ink-faint` | `#706e6e` | A `--grey-706e6e` |
| `--z-arch-*` | see archetype section | shades of the sourced blue |

Top hex frequencies in A: `#fff` ×24, `#000` ×12, `#2067ff` ×10, `#4aaeff` ×9, `#ddd` ×6,
`#222` ×6, `#ccc` ×4, `#333` ×4, `#fafafa` ×3, `#f5f5f5` ×3, `#000b1c` ×3.

**Neither reference contains a gradient, a glassmorphism blur, or a neon accent.** None are used.

---

## Typography

System stack — decided in the brief, not re-litigated. Renders genuine SF Pro on macOS/iOS
(the primary user's environment) and falls back to Inter elsewhere. No self-hosted SF Pro
files; Inter is fallback only, never loaded as primary.

```css
--z-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display",
          system-ui, "Inter", "Helvetica Neue", Arial, sans-serif;
```

### Display tracking — cross-checked across both references

| Site | Element | Size | Tracking | Ratio |
|---|---|---|---|---|
| zfellows (A `.new-heading-style-h1`) | h1 | `4.5rem` | `-0.2rem` | **−0.044em** |
| internapalooza (C) | h1 | `40px` | `-1.6px` | **−0.040em** |

The two agree independently, so **≈ −0.04em display tracking** is a finding rather than one
site's quirk. It is the anchor for the scale below.

### App scale

Marketing h1 at `4.5rem` is unusable at data density. The app scale steps down the marketing
scale while using **only sizes and tracking values that already appear in Source A**.

| Role | Size | Tracking | Line-height | Weight | Source A occurrences |
|---|---|---|---|---|---|
| display | `3rem` | `-0.12rem` | `1` | 700 | `font-size:3rem` ×10 |
| h1 | `2.5rem` | `-0.08rem` | `1.1` | 700 | `2.5rem` ×10; `-.08rem` ×3 |
| h2 | `2rem` | `-0.06rem` | `1.2` | 700 | `2rem` ×13; `-.06rem` ×3 |
| h3 | `1.5rem` | `-0.045rem` | `1.2` | 600 | `1.5rem` ×20; `-.045rem` ×5 |
| h4 | `1.25rem` | `-0.0375rem` | `1.3` | 600 | `1.25rem` ×27; `-.0375rem` ×5 |
| body | `1rem` | `-0.02rem` | `1.5` | 400 | `1rem` ×31; `-.02rem` ×7 |
| small | `0.875rem` | `-0.02rem` | `1.4` | 400 | `.875rem` ×10 |
| micro | `0.8125rem` | `0.01rem` | `1.15` | 500 | A `.blog-publish-wrap` `font-size:.81rem` |
| eyebrow | `0.875rem` | `+0.09em` | `1.2` | 800 | B `.text-28px-extra-bold.text-style-allcaps`: 28px/800/uppercase/`ls 1.12px` (= +0.04em), colour `#2067ff`. Scaled 28px→0.875rem for app density; tracking increased to +0.09em to hold legibility at the smaller size — **the one derived typographic value, flagged.** |

Line-height frequency in A confirms the ladder: `1.2` ×25, `1.4` ×12, `1.5` ×9, `1.3` ×8, `1` ×8.

Letter-spacing values present in A: `-.02rem` ×7, `-.05rem` ×6, `-.03em` ×6, `-.0375rem` ×5,
`+.01rem` ×4, `-.2rem` ×3, `-.1rem` ×3, `-.08rem` ×3, `-.06rem` ×3, `-.045rem` ×3.

---

## Radius

Frequency in A: `1rem` ×12, `.5rem` ×10, `100%` ×9, `.75rem` ×9, `50%` ×8, `1.25rem` ×7,
`9999rem`/`999rem` ×8 (pills), `1.1875rem` ×2 (tag pill).

| Token | Value | Use | Source |
|---|---|---|---|
| `--z-r-pill` | `999rem` | buttons, segmented control | A `.new-button` |
| `--z-r-tag` | `1.1875rem` | tag / badge pills | A `.blog-publish-wrap` |
| `--z-r-card` | `0.75rem` | standard card | B, most common observed card radius (12px) |
| `--z-r-card-lg` | `1.25rem` | large card | A `.faqs_wrapper` (20px) |
| `--z-r-sm` | `0.5rem` | inputs, small surfaces | A ×10 |
| `--z-r-circle` | `100%` | graph nodes, avatars-as-dots | A `.pagination-no-item` |
| `--z-r-email` | `4px` | **digest only** — see deviation note | derived |

---

## Shadow

| Token | Value | Source |
|---|---|---|
| `--z-shadow-btn` | `inset 0 4px 8px #75a9ff66, inset 0 -4px 8px #75a9ff33` | A `.new-button` |
| `--z-shadow-btn-neutral` | `inset 0 4px 8px #e5e7ea80, inset 0 -4px 8px #efefef` | A |
| `--z-shadow-card` | `0 2px 12px #00000014` | A |
| `--z-shadow-lift` | `0 2px 20px #0000001a` | A |
| `--z-shadow-float` | `4px 8px 20px #72727233` | A |

---

## Motion

Durations in A: `.2s` dominant (`background-color .2s` ×3, `color .2s` ×2, `transform .2s` ×2,
`filter .2s` ×2), `.3s` (`all .3s` ×3), `.4s` (`all .4s` ×3), `.5s` (`transform .5s,opacity .5s` ×2).

**No custom `cubic-bezier` appears anywhere in Source A** — default `ease` throughout.

| Token | Value |
|---|---|
| `--z-t-fast` | `0.2s ease` |
| `--z-t-base` | `0.3s ease` |
| `--z-t-slow` | `0.4s ease` |

All motion respects `prefers-reduced-motion: reduce`.

---

## Spacing — marketing rhythm and its app derivation

Source A section padding: `.padding-section-small` `3rem`, `.padding-section-medium` `6rem`,
`.padding-section-large` `12rem` (responsively overridden to `6rem`).

Source A component padding, on a `0.25rem` grid: `.75rem` ×5, `1rem` ×6, `1.25rem` ×4,
`1.5rem` ×6, `2rem` ×9, `2.5rem` ×7, `3rem` ×3, `4rem` ×7.

**Density derivation.** The brief requires more information density than a marketing site while
keeping tokens strict. Resolution: keep the `0.25rem` base grid exactly as-is, **halve the
section rhythm**, and reuse the marketing *component* scale at *section* level. Every app
spacing value therefore already exists in Source A — applied one level tighter, not invented.

| Token | Value | Derivation |
|---|---|---|
| `--z-space-1` … `-6` | `.25 / .5 / .75 / 1 / 1.25 / 1.5rem` | marketing component scale, unchanged |
| `--z-space-8 / -10 / -12` | `2 / 2.5 / 3rem` | marketing component scale, unchanged |
| `--z-section` | `1.5rem` | marketing `-small` `3rem` ÷ 2 |
| `--z-section-lg` | `3rem` | marketing `-medium` `6rem` ÷ 2 |

---

## Image treatment

All 30 hero images on zfellows.com compute to `filter: grayscale(1)` and
`border-radius: 0px` (Source B — 30/30, no exceptions).

Candidate avatars therefore ship **grayscale and square**. This is both directly sourced and
happens to avoid the round-avatar dashboard reflex the brief warns against.

---

## Component primitives found in Source A

The brief's hardest requirement is that data-tool components (table, filter rail, graph) not
drift into generic dashboard defaults. These are the real marketing-site rules each one extends.

| Primitive | Source A rule | Extended into |
|---|---|---|
| Button | `.new-button` — `#2067ff`, `999rem`, `padding .875rem 2.5rem`, `1.5rem/600`, `ls -.045rem`, inset glow | `Button` |
| Tag pill | `.blog-publish-wrap` — `radius 1.1875rem`, `padding .43rem .93rem`, `.81rem/500`, `bg #44416117`, `color #000b1ccc` | `Pill`, `ZScoreBadge`, `ArchetypeTag` |
| Segmented control | `.content-tab-link` — `radius 6.4375rem`, `padding .75rem 20px`, `1.125rem/500`, inactive `opacity .7` | `SegmentedControl` → queue filters |
| Circular node | `.pagination-no-item` — `radius 100%`, `3.18rem` square, `bg #e5e5f3`, `1px solid #e5e5f3`, `transition all .3s` | graph nodes, `RatingControl` buttons |
| Card | `.faqs_wrapper` (`#f7f4e9`, 20px) · `.investors_logo-wrapper` (`#f7f4e9`, 12px) | `Card` |
| Flat divider surface | `.new-mentor_content-wrapper` — `#ebebeb`, radius `0` | table row separators |
| Nav link | `.new-navbar_link` — `16px/500`, `ls -.8px`, `padding 16px 20px`, `#222` | `Nav` |

---

## Deliberate deviations

1. **Digest radius and shadow.** Email clients (notably Outlook's Word rendering engine) drop
   `border-radius: 999rem` and all `inset` shadows. The digest route therefore uses
   `--z-r-email: 4px` and flat fills instead of `--z-r-pill` and `--z-shadow-btn`. This is the
   only place tokens are intentionally overridden, and it is required by the email-safe
   constraint in the brief.
2. **Eyebrow tracking.** `+0.09em` rather than the source's `+0.04em`, because the eyebrow is
   scaled from 28px down to 0.875rem and uppercase tracking must grow as size shrinks to stay
   legible. Flagged as derived.

---

## UNKNOWN — could not be determined, not filled with invention

1. **Nav scroll behaviour.** Computed `position: relative` at scroll-top (Source B). The scroll
   interaction timed out before sticky-on-scroll could be confirmed, and Webflow applies such
   behaviour via JS rather than CSS. → The app nav ships `position: sticky` as an explicit
   **app-usability decision, not a sourced value**.
2. **Section-level dark.** `--dark-blue: #000b1c` is defined in A, but a computed scan of every
   element over 200px tall found **no dark full-bleed section** on the homepage. Dark appears
   only as `#33363b` *cards* (20 instances, 12px radius). → Dark is a card treatment on this
   site, not a section treatment. The graph canvas is the single place a dark surface is used,
   and it uses the sourced `#33363b`.
3. **Mobile computed styles.** Captured at 1440×900 only; 390px not captured. → Breakpoint
   values must be verified at 390px during implementation before mobile layouts are finalised.
4. **Hover and focus states.** Not captured — would require `:hover` simulation per element.
   → Derived from the `.2s` transition tokens: hover darkens via `filter: brightness(1.08)`,
   focus uses a 2px `--z-blue` outline at 2px offset. **Both derived, flagged here.**

---

## Archetype colour — resolved

The brief asked for graph nodes "coloured by archetype" across five clusters, while
zfellows.com ships one accent plus one light blue. Two earlier attempts were rejected: five
invented hues (unsourced), then a 2px left rule on each tag (reads as generated).

**Resolved** by client direction to use shades of blue that stay inside the Z Fellows scheme.
The ramp interpolates the sourced `#2067ff`, `#4aaeff` and `#75a9ff`, extended one step darker
and one step lighter:

| Token | Value | Basis |
|---|---|---|
| `--z-arch-olympiad` | `#0b3fd4` | shade of sourced `#2067ff` |
| `--z-arch-research` | `#2067ff` | sourced, A `--primary-blue` |
| `--z-arch-builder` | `#4aaeff` | sourced, A `--light-blue` |
| `--z-arch-founder` | `#75a9ff` | sourced, A button inset glow |
| `--z-arch-polymath` | `#a8c8ff` | tint of sourced `#2067ff` |

Used as **node fill in the graph only**. Archetype tags in tables stay neutral, because five
tinted pills repeated down a dense list is noise. The two lightest shades take `--z-navy` text
for legibility.
