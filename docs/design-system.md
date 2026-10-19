# Design system

Light Runner's pages share one look: **dark navy soft glass**. Panels and controls are flat, translucent surfaces with a faint 1 px edge. There are no bevels, no inset wells and no heavy shadows. Selected, held and warning states are tinted glass: blue, amber or red. It is built for a dark church: no large area gets bright, fixture colours are mixed down, and the bright accent only appears as thin lines.

Tokens and base components live in [web/shared/theme.css](../web/shared/theme.css). Every page loads it before its own stylesheet. Shared classes are prefixed `ds-` so they never clash with a page's own class names.

How the direction was agreed with Ilmārs (19 Oct 2026):

1. A first "dark neumorphic" pass, with the palette adjusted for the dark room (see Brightness).
2. A refinement pass: two surface levels, an integrated bottom strip, and running-order states.
3. The current direction: **modern dark soft glass** (flat glassmorphism, bento layout), from a dark dashboard reference. Neumorphism, bevels, metallic controls and slider thumbs were dropped.

## Colours

| Token | Value | Use |
| --- | --- | --- |
| `--ds-bg` / `--ds-bg-deep` | `#0F1625` / `#0C121F` | Page background, close to the panels' tone so the page reads as one surface; soft radial glow from the top (`#18233b`) |
| `--ds-surface` / `--ds-surface-hi` | `#121A2B` / `#162034` | Solid surface tones |
| `--ds-panel-fill` | translucent `rgba(27,37,60,.78)` to `rgba(17,24,40,.78)` | Panels (glass) |
| `--ds-tile-fill` | `rgba(148,170,210,.055)` | Tiles and buttons at rest |
| `--ds-elevated` | `rgba(148,170,210,.10)` | Pressed |
| `--ds-tile-fill-on` + `--ds-edge-on` | blue tint `rgba(84,146,236,.17–.26)`, edge `rgba(98,155,240,.45)` | Selected: running-order item on stage, tabs, Save, Done, the current swatch |
| `--ds-selected` | `rgba(84,146,236,.24)` | Held (Flash) |
| `--ds-glass` | `rgba(14,20,34,.86)` + 16 px blur | Surfaces that overlap others: picker, new-quick-look sheet, Fade menu, toast |
| `--ds-accent` | `#4389E8` | Thin lines only: focus edge, Save while held |
| `--ds-accent-fill` | `#3A6FB8` | Save's hold fill, at 45 % |
| `--ds-text` / `--ds-muted` / `--ds-muted-on` | `#E6EAF2` / `#8F9AB0` / `#B4BDCF` | Text, labels, labels on tinted areas |
| `--ds-warn`, `--ds-warn-text` | `#c98a2a`, `#e0b46a` | "changed", Master below full, problems with the lights |
| `--ds-danger` (`224,90,104`) + `-text`, `-fill`, `-edge` | red glass | Blackout, delete, error toast |
| `--ds-ok` | `#2f9e5b` | Connected dot |

### Brightness

The first suggested palette was measured at about 4× the old screen's average brightness, with a light-grey selected tile 12× the old raised tile. The rules that came out of that still hold:

- No large area is bright. Tints stay under about 26 % opacity.
- `--ds-accent` is only used as a line of 1–2 px.
- Fixture colours are mixed down. Slider fills carry 15–26 % of the group's colour, swatches are at 0.8–0.85 opacity and the "Any colour" strip at 0.55.
- Check new values on the real iPad at the church's usual brightness; a screenshot can't show it.

## Shape and type

| Token | Value |
| --- | --- |
| `--ds-r-panel` / `--ds-r-tile` / `--ds-r-small` / `--ds-r-pill` | 18 / 12 / 10 / 999 px |
| `--ds-gap` / `--ds-gap-tight` | 10 / 8 px |
| `--ds-target` | 44 px minimum touch target |
| `--ds-shadow-raise` | Panels: faint edge plus a very soft far shadow |
| `--ds-shadow-low`, `--ds-shadow-inset` | Controls: faint edge only |
| Type | System font. Panel titles semibold 15 px in title case ("Running order", "Quick looks"). Control labels in small spaced capitals (Master, Flash, Next). Group names 13 px muted. Levels 20 px with numbers that keep their width. Current item 500. |

## Components

| Class | What | Notes |
| --- | --- | --- |
| `ds-panel` | Glass panel of the bento layout | Faint edge; translucent fill |
| `ds-tile` (+ `ds-on`) | Flat tile inside a panel | Selected = blue tint and blue edge |
| `ds-label` | Muted small label above a value | "Key lights" over "Vēsi balts" |
| `ds-btn`, `ds-btn--text`, `ds-btn--pill` | Button, quiet text button, pill | Pressed = lighter tint; disabled = 40 % opacity |
| `ds-hold` + `ds-hold-fill` | Button that fills while held | Save (blue), Blackout (red) |
| `ds-fill` + `-slab`, `-val` | Fill slider | A smooth filled bar on a faint track, no thumb; the fill carries a little of the group's colour (`--c`); the value is shown beside it |
| `ds-seg` | Segmented control and tabs | Faint track; selected = blue tint and edge |
| `ds-field` | Text field | Flat; focus = accent edge |
| `ds-sheet` | Glass sheet over one panel | The only place blur is used |
| `ds-swatch` | Colour square | Dimmed |

## Where it is applied

| Area | State |
| --- | --- |
| Operator page: everything (frame, top bar, running order and edit mode, quick looks, details, colour picker, new-quick-look sheet, bottom bar) | Done |
| Settings | Done: glass panels in a two-column bento grid on wide screens (DMX output, Show and Compare span both), tinted segmented choices and switches (Send DMX on is green), flat fields, status pills, glass top bar and save bar |
| Patch (frame and controls; the DMX map and stage plan keep their own look) | Partly: it loads the Settings base, so frame, cards, buttons and fields already match; its own controls still to do |

### Operator page rules

- **Surfaces:** glass panels on the background. Group zones in Details are flat and divided by a faint line, not cards inside a card. The bottom bar is one strip whose groups are divided by faint lines.
- **Levels:** a clear number on the right of the group's header line, never drawn over the slider. 0 % is muted.
- **Running order colours:** one small dot per group, in group order (Basic lights' unsaved groups show the built-in warm light).
- **Whites are drawn as whites everywhere** (running order, colour chips, picker swatches, quick-look strips, the stage preview, the warm-to-cool strip): a light colour with little colour in it (chroma under 65 %, e.g. warm white `#ffb46b`, cool white `#dcebff`) is mixed 60 % towards cream `#f1ece4`, keeping its brightness. Saturated colours are unchanged, and nothing changes in what is sent to the lights.
- **Details adapt to the rig:** with few groups each zone grows into the spare room (up to 124 px, the slider up to 64 px tall); with many groups they shrink back to their content (slider 44 px) and the list scrolls, so capacity isn't lost.
- **Quick looks** keep a fixed two rows (12 looks before scrolling), so the layout doesn't jump when switching tabs.
- **Running order:**
  - on stage: blue-tinted glass with a blue edge
  - changed: an amber dot and "changed"
  - the item Next will start: a quiet "next"
- **Header actions** (Edit, Back to …, Save, Done) are pills.
- **Operational states**, each different:
  - Flash held: blue tint and edge.
  - Master below 100 %: amber value and an amber fill.
  - Blackout: faint red at rest, filling red while held. While it's on, strong red glass on the button and the whole top bar.
  - Problems with the lights: an amber strip on the top bar.
  - Send DMX off: an amber pill, **DMX output inactive**, with a faint amber strip on the top bar. Hover or tap the pill for the full explanation.
  - Lights not answering, or another desk is sending: the same amber pill with that short label; the full message on hover or tap.

  Colour is only used where it says something.

## Audit notes (19 Oct 2026)

What the restyle fixed, from a read-through of all three pages before the work:

- **Tokens weren't shared.** The operator and settings pages each had their own, with different text, muted and danger colours; patch borrowed settings'. The operator page had 50+ one-off colours and 7 corner radii for objects at the same level.
- **"Selected" was drawn five different ways:** running order, tabs, preset tiles, segmented choices and the Fade menu. Quick-look tiles have no "current" state.
- **Held states** (Save, Blackout, Flash) each looked different.
- **Some operator targets were under 44 px:** the dimmers (40 px, now 44 px), the rename field (40 px, now 44 px) and the Master track (28 px, now 32 px inside a 58 px strip).
- **The operator toast was always red,** even for "Saved".
