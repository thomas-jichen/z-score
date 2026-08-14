# Design language

Standing rules for this project and future ones. Tokens live in
[`DESIGN_TOKENS.md`](./DESIGN_TOKENS.md); this file is about judgement.

Target: VC-backed and premium. The bar is what leading engineers at Apple or Anthropic would
ship. Sleek, polished, seamlessly natural to use. Something a user wants to come back to.

## Hard bans

These are the tells that make a page read as machine-generated. No exceptions.

| Banned | Instead |
|---|---|
| Middle dot `·` as separator | A space, a line break, or nothing |
| Em dash in UI copy | A period, or restructure the sentence |
| Tracked-out letter spacing, especially all-caps | Normal tracking, sentence case |
| Small vertical rule attached before a word | Nothing, or carry the meaning in the word itself |
| ALL CAPS subtitles, eyebrows, table headers | Sentence case at a smaller size and muted colour |

## Structure

**Two text levels per block, never three.** A title and a subtext. An eyebrow above a heading
above a paragraph is one element too many. If a third fact matters, fold it into one of the two.

**Progressive disclosure over completeness.** When a control set or a body of text gets dense,
collapse it. Forty school chips laid flat is clutter. Forty behind a disclosure is a feature.
Whitespace is worth more than everything being visible at once.

**Cut aggressively.** Verbosity is the default failure. Every element should survive the
question "what breaks if this is gone?"

## Positive rules

- **Whitespace is structural.** Space carries hierarchy more reliably than rules, borders,
  or background fills.
- **Restrain the accent.** One accent colour, used where it means something. Blue on a
  z-score means outlier. Blue everywhere means nothing.
- **Sentence case throughout**, including buttons, labels and table headers.
- **Let numbers breathe.** In a data tool the figures are the content; give them size and
  space rather than crowding them with labels.
- **Quiet surfaces.** Prefer a flat tone shift to a border. Prefer a border to a shadow.
- **Motion is confirmation, not decoration.** 0.2s transitions on state change; nothing that
  announces itself.

## Applies everywhere

Auth and login screens are the easiest place to leave something generic and the first thing
anyone sees. They get the same treatment as the primary surface.
