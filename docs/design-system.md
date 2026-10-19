# Design system

Light Runner's pages share one look: dark navy, soft raised panels instead of borders, muted at rest and lighter when selected. It is built for a dark church: large areas never get bright, and the bright accent only appears as thin marks.

Tokens and base components live in [web/shared/theme.css](../web/shared/theme.css). Every page loads it before its own stylesheet. Shared classes are prefixed `ds-` so they never clash with a page's own class names.

Direction agreed with Ilmārs on 19 Oct 2026: "Premium dark neumorphic", from a reference industrial control screen, using the palette adjusted for the dark room (not the brighter one first suggested; see Brightness below).

## Colours

| Token | Value | Use |
| --- | --- | --- |
| `--ds-bg` | `#0F1626` | Page background (with a soft radial gradient to `--ds-bg-deep` `#0B111E`) |
| `--ds-surface` / `--ds-surface-hi` | `#192238` / `#1D2741` | Panels: bottom and top of their gradient |
| `--ds-elevated` | `#25324F` | Tiles and buttons at rest |
| `--ds-selected` | `#34466D` | Selected, active or held; the lightest large area allowed |
| `--ds-mark` | `#68758F` | Grips, ticks, handles only (never a large area) |
| `--ds-accent-fill` | `#3A6FB8` | Accent for areas (Save fill, at half strength) |
| `--ds-accent` | `#4389E8` | Accent for thin lines only: focus ring, drag outline |
| `--ds-text` | `#E6EAF2` | Text |
| `--ds-muted` | `#9AA5BA` | Labels and inactive text on panels |
| `--ds-muted-on` | `#B4BDCF` | Labels on tiles and selected areas (keeps contrast) |
| `--ds-warn`, `--ds-warn-text` | `#c98a2a`, `#e0b46a` | "changed", problems with the lights |
| `--ds-danger-text` / `--ds-danger-fill` | `#E0A3A3` / `#3A1F26` | Blackout, delete |
| `--ds-ok` | `#2f9e5b` | Connected dot |

### Brightness

The first suggested palette (background `#151D30`, surface `#222E4B`, elevated `#34466D`, selected `#68758F`, accent `#4389E8`) was measured at about 4× today's average screen brightness. A `#68758F` tile was 12× the old raised tile, and a solid `#4389E8` area would have been the brightest thing in the room. The adjusted palette is about 2.3× today's, and every text colour passes WCAG AA on the surfaces it sits on. Rules:

- No large area lighter than `--ds-selected`.
- `--ds-accent` only as a line of 2–4 px; areas use `--ds-accent-fill` at partial opacity.
- The light half of a soft shadow stays at 4–6 % white, so it never reads as an outline.
- Saturated colours (swatches, colour strips) are dimmed: swatches at 0.8–0.85 opacity, the "Any colour" strip at 0.55, group tints at 0.14.
- Check new values on the real iPad at the church's usual brightness; a screenshot can't show it.

## Shape and type

| Token | Value |
| --- | --- |
| `--ds-r-panel` / `--ds-r-tile` / `--ds-r-small` | 20 / 14 / 10 px |
| `--ds-gap` / `--ds-gap-tight` | 12 / 8 px (soft shadows need at least 12 px between panels) |
| `--ds-target` | 44 px minimum touch target |
| `--ds-shadow-raise` | panels |
| `--ds-shadow-low` | tiles and buttons |
| `--ds-shadow-inset` | sunken things: slider tracks, fields, pressed buttons |
| Type | system font, regular weight (400, 500 for the current item); size carries the hierarchy: label 13, body 16, value 18, title 22 px |

## Components

| Class | What | Notes |
| --- | --- | --- |
| `ds-panel` | Bento panel on the background | No border; raised shadow and faint top edge |
| `ds-tile` (+ `ds-on`) | Raised tile inside a panel | Selected uses `--ds-selected` |
| `ds-label` | Muted small label above a value | "Key lights" over "Vēsi balts" |
| `ds-btn`, `ds-btn--text` | Button, quiet text button | Pressed = inset shadow; disabled = 40 % opacity |
| `ds-hold` + `ds-hold-fill` | Button that fills while held | Save, Blackout |
| `ds-fill` + `-slab`, `-tint`, `-grip`, `-val` | Fill slider | Sunken track; lighter slab for the level; value inside on the left; grip at the slab's end; optional colour tint over the slab |
| `ds-seg` | Segmented control and tabs | Selected = raised lighter tile |
| `ds-field` | Text field | Sunken; accent focus ring |
| `ds-sheet` | Sheet covering one panel | Colour picker, new quick look |
| `ds-swatch` | Colour square | Dimmed |

## Where it is applied

| Area | State |
| --- | --- |
| Operator page: everything (frame, top bar, running order and edit mode, quick looks, details, colour picker, new-quick-look sheet, bottom bar) | Done (two passes) |
| Settings | To do |
| Patch (frame and controls; the DMX map and stage plan keep their own look) | To do |

### Operator page rules (second pass)

- Two levels only. Panels are level 1. Controls are level 2: raised a little (buttons, tiles, the item on stage) or sunk in (slider tracks, fields, tab bars). Group zones in Details are flat, divided by a faint line, not cards inside a card. The bottom bar is one strip with its groups divided by faint lines.
- Section headers are small spaced capitals (`.sec-title`, 11 px, 0.09 em): Running order, Quick looks, Master, Flash, Next.
- Levels are a clear number on the right of the group's header line (20 px, numbers keep their width), never drawn over the slider; 0 % is muted.
- The slider's slab carries a little of the group's own colour (`--c`, mixed at 10–26 %); the thumb is a small raised pill at the slab's end.
- Running order states: on stage = lighter tile with a 3 px accent bar; changed = amber dot and "changed"; the item Next will start = a quiet "next".
- Operational states, each different: Flash held = pressed in and lighter; Master below 100 % = amber value; Blackout held = filling red; Blackout on = strong red button and a red top bar. Colour is only used where it says something.

## Audit notes (19 Oct 2026)

What the restyle is fixing, from a read-through of all three pages before the work:

- The pages didn't share tokens: operator and settings each had their own, with different text, muted and danger colours; patch borrowed settings'. The operator page had 50+ one-off colours and 7 corner radii for objects at the same level.
- "Selected" was drawn five different ways (running order, tabs, preset tiles, segmented choices, the Fade menu). Quick-look tiles have no "current" state.
- Held states (Save, Blackout, Flash) each looked different.
- Some operator targets were under 44 px: the dimmers (40 px, now 48 px), the rename field (40 px) and the Master track (28 px).
- The operator toast was always red, even for "Saved".
