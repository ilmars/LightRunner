# Design system

Light Runner's pages share one look: **dark navy soft glass**. Panels and controls are flat, translucent surfaces with a faint 1 px edge. There are no bevels, no inset wells and no heavy shadows. Selected, held and warning states are tinted glass: blue, amber or red. It is built for a dark church: no large area gets bright, fixture colours are mixed down, and the bright accent only appears as thin lines.

Tokens and base components live in [web/shared/theme.css](../web/shared/theme.css). Every page loads it before its own stylesheet. Shared classes are prefixed `ds-` so they never clash with a page's own class names.

How the direction was agreed with Ilmārs (19 Oct 2026):

1. A first "dark neumorphic" pass, with the palette adjusted for the dark room (see Brightness).
2. A refinement pass: two surface levels, an integrated bottom strip, and running-order states.
3. **Modern dark soft glass** (flat glassmorphism, bento layout), from a dark dashboard reference. Neumorphism, bevels, metallic controls and slider thumbs were dropped.
4. The designer's restyle (20 Oct 2026, [restyle design](superpowers/specs/2026-10-20-restyle-design.md)): the same direction with the designer's values. Flat panels with a 1 px edge on a darker ground, four colours with fixed meanings (blue, amber, red, violet), small spaced capitals over values.

## Colours

| Token | Value | Use |
| --- | --- | --- |
| `--ds-bg` / `--ds-bg-deep` | `#090F1C` / `#070C17` | The ground (flat on the operator page) |
| `--ds-surface` / `--ds-surface-hi` | `#141D30` / `#18233A` | Solid surface tones (a panel over the ground) |
| `--ds-panel-fill` + `--ds-shadow-raise` | `rgba(28,39,62,.58)`, 1 px edge `rgba(148,163,184,.14)` drawn inside | Panels, the top bar and the bottom bar |
| `--ds-edge` | `rgba(148,163,184,.14)` | The 1 px edge of panels, tiles and buttons |
| `--ds-tile-fill` | `rgba(255,255,255,.035)` | Tiles and buttons at rest |
| `--ds-elevated` | `rgba(148,163,184,.10)` | Pressed |
| `--ds-tile-fill-on` + `--ds-edge-on` | blue `rgba(67,137,232,.16)`, edge `.5` | **Blue = selected / on stage**: the item on stage, tabs, Live, Go |
| `--ds-selected` + `--ds-edge-held` | `rgba(67,137,232,.22)`, edge `.7` | Held (Flash, Puff); Go's edge |
| `--ds-warn`, `--ds-warn-text`, `-tint`, `-edge` | `#E3A646`, tint `.13`, edge `.38` | **Amber = changed, Master below full, problems** |
| `--ds-danger` (`227,106,111`) + `-text` `#EC8286`, `-fill` `.12`, `-edge` `.35` | red glass | **Red = Blackout, delete**, error toast |
| `--ds-violet`, `-tint`, `-edge` | `#B0A6F5`, `rgba(161,147,242,.13)`, `rgba(171,160,244,.5)` | **Violet = Prepare**, nothing else |
| `--ds-glass` | `rgba(20,28,46,.94)` + 16 px blur | Surfaces that overlap others: picker, quick-look sheet, Fade and Tempo menus, toast |
| `--ds-popover` | `#141C2E` | The problem explanation (solid) |
| `--ds-accent` | `#4389E8` | Thin lines only: focus edge, Save while held |
| `--ds-accent-fill` | `#3A6FB8` | Save's hold fill, at 35 % |
| `--ds-text` / `--ds-muted` / `--ds-muted-on` | `#E3E8F0` / `#97A4BA` / `#B7C1D1` | Text, labels, labels on tinted areas |
| `--ds-ok` | `#2f9e5b` | Settings: Send DMX on |

### Brightness

The first suggested palette was measured at about 4× the old screen's average brightness, with a light-grey selected tile 12× the old raised tile. The rules that came out of that still hold:

- No large area is bright. Tints stay under about 26 % opacity.
- `--ds-accent` is only used as a line of 1–2 px.
- Fixture colours are mixed down. Slider fills carry 15–26 % of the group's colour, swatches are at 0.8–0.85 opacity and the "Any colour" strip at 0.55.
- Check new values on the real iPad at the church's usual brightness; a screenshot can't show it.

## Shape and type

| Token | Value |
| --- | --- |
| `--ds-r-panel` / `--ds-r-bar` / `--ds-r-tile` / `--ds-r-small` / `--ds-r-pill` | 18 / 16 (top and bottom bars) / 12 / 10 / 999 px |
| `--ds-gap` / `--ds-gap-tight` | 10 / 8 px |
| `--ds-target` | 44 px minimum touch target; 52 px in the operator page's bottom bar |
| `--ds-shadow-raise`, `--ds-shadow-low` | The 1 px edge, drawn inside (no far shadow) |
| Type | System font (Inter comes with the restyle's last step). Panel titles 14 px semibold in sentence case ("Running order", "Quick looks", "Groups") with a muted 12–13 px subtitle beside them. Small labels (`ds-caps`): 11 px, 600, `.09em` spacing, upper case, muted ("On stage", "Master", "Flash", "Who to call"); 10 px over a value inside a button (Fade, Tempo, Safe, Next). The name on stage 20 px semibold. Levels 17 px semibold with numbers that keep their width. |

## Components

| Class | What | Notes |
| --- | --- | --- |
| `ds-panel` | Glass panel of the bento layout | Faint edge; translucent fill |
| `ds-tile` (+ `ds-on`) | Flat tile inside a panel | Selected = blue tint and blue edge |
| `ds-caps` | Small spaced capitals over a value | "ON STAGE" over the name, "MASTER", "WHO TO CALL" |
| `ds-label` | Muted small label above a value | "Key lights" over "Vēsi balts" |
| `ds-btn`, `ds-btn--text`, `ds-btn--pill` | Button, quiet text button, pill | Pressed = lighter tint; disabled = 40 % opacity |
| `ds-hold` + `ds-hold-fill` | Button that fills while held | Save (blue), Blackout (red) |
| `ds-fill` + `-slab`, `-val` | Fill slider | A filled bar on a faint track with a 1 px edge, no thumb; the fill is the control's colour (`--c`) at 22 % with a 2 px line of it (70 %) at the level; the value is shown beside it; `ds-disabled` = 40 % opacity and it doesn't react to a finger (no page uses it since Preview went; kept for a control that can't move) |
| `ds-seg` | Segmented control and tabs | A dark track (`rgba(0,0,0,.2)`) with the edge; selected = blue tint and edge |
| `ds-field` | Text field | Flat; focus = accent edge |
| `ds-sheet` | Glass sheet over one panel | The only place blur is used |
| `ds-swatch` | Colour square | Dimmed |

## Where it is applied

| Area | State |
| --- | --- |
| Operator page | The designer's restyle (20 Oct): tokens, top bar, running order, quick looks, Groups, bottom bar and colour picker done; the editors, quick-look sheet, Individual lights, phone, font and icon follow |
| Operator page on a phone (the remote) | Done: Order, Groups and Looks tabs; Master and the dock always visible; no saving or editing; side by side when the phone is on its side |
| Settings | Done: glass panels in a two-column bento grid on wide screens (DMX output, Show and Compare span both), tinted segmented choices and switches (Send DMX on is green), flat fields, status pills, glass top bar and save bar |
| Patch | Done: the fixture table has no cell borders, faint row dividers and flat fields; group cards are flat glass tiles with pill chips and turn blue-tinted while one of their fields has focus; the DMX map, universe tabs, library list and Open Fixture Library search use the same glass and tinted states. Fixture blocks keep their own per-type colours and the red overlap striping; the stage plan keeps its grid and marks inside a glass frame |

### Operator page rules

The designer's mockup (`Main.dc.html`, kept with the restyle plan) is the reference for sizes and wording.

- **Frame:** 10 px around and between; a 60 px top bar and a 76 px bottom bar (radius 16), a 292 px left column (the stage view in its own panel, 124 px, on `#04070D`, then the running order) and the right column (Quick looks, then Groups).
- **Add tiles** have a dashed edge (`rgba(148,163,184,.28)`; `.3` in the picker): ＋ Add song, ＋ Save stage as a look, ＋ New colour, ＋ New effect. They are always the last tile and always there.
- **Header buttons** (Edit list, Edit looks) are quiet: muted text, the edge, no fill, 44 px, radius 10. Back to saved and Save have the tile fill.
- **Levels:** a clear number on the right of the row, never drawn over the slider. 0 % is muted.
- **Groups:** one row per group, 64 px, divided by a faint line: name (14 px semibold) · a colour button (a round swatch, the colour's name, a chevron; Off is a ring) · a 48 px fill slider with two grip marks at its left · the level. The rows scroll when there are many groups.
- **Running order colours:** one 7 px dot per group, in group order; a group the item leaves alone is faint, one it turns off is a ring (Basic lights' unsaved groups show the built-in warm light).
- **Whites are drawn as whites everywhere** (running order, colour chips, picker swatches, quick-look strips, the stage view, the warm-to-cool strip): a light colour with little colour in it (chroma under 65 %, e.g. warm white `#ffb46b`, cool white `#dcebff`) is mixed 60 % towards cream `#f1ece4`, keeping its brightness. Saturated colours are unchanged, and nothing changes in what is sent to the lights. Dots, swatches and strips are drawn at 80–85 % opacity.
- **Colour picker** (`#picker.cpick`): takes the Groups panel's place (the rows hide, the panel stays; Quick looks stay). Header: "‹ Groups" (quiet), the group (17 px semibold), its colour as a 14 px round swatch with the name and level (muted 13 px), the Colours / Effects tabs (the Quick looks tabs' segmented style) and Done (tile fill, 600). Lists under a small-capitals label with their button at the right ("Colours · tap to fade to it" + Edit this colour; "Any colour · drag to try it live" + ＋ Keep as a colour; an unavailable button is at 40 %). Tiles 58 px (effects 62 px), radius 12, the 1 px edge, a 22 px bar of the colour at 82 % over the 13 px name (an effect's moving swatch 20 px); the group's current one blue-tinted with a `.55` blue edge, the one open in an editor an accent edge. Six colours to a row, five effects. The Any colour strip is 40 px at 55 % with a 3 px light handle standing out 3 px above and below. The running effect's card: `rgba(0,0,0,.16)` with the edge, radius 14, "<effect> is running" (14 px semibold) with the muted 12 px round's length, All settings › at the right, and a Speed row (a 64 px label, the segmented choice, "beats a round"). A group that isn't a line gets a centred "Effects need a line of lights" and which groups take them.
- **White, Amber and UV** (colour picker, groups that have them): fill sliders three to a row under Any colour, "White 0 %" in muted 12 px over a 44 px slider, the fill carrying a little white, amber or violet.
- **Smoke groups** (smoke or haze machines) in Groups: a muted "Smoke" label and a **Puff** button where the colour button would be, and a grey fill (no colour). Puff held is tinted like Flash. The top bar's "Smoke: N %" is plain muted text, not a warning.
- **Fade and Tempo** (top bar): buttons with a 10 px label over the value ("Fade" over "Auto", "Tempo" over "120 bpm"), each opening a small glass menu (Tempo's: ×2, ÷2, − and +, in a row). **Tap** beside them lights with the blue tint for a moment on each tap. On the phone they share a row at the top of Groups.
- **Quick looks:** six to a row, 56 px tiles with the name and a strip of 3 px blocks, one per group (faint for a group it leaves alone, grey for one it turns off); two rows show, more scroll.
- **Running order tags** (12 px, at the right of the row): "● changed" in amber on the item on stage; "next" on the item Next starts; a quiet "safe look" on Basic lights, with a divider under it. In Prepare: "preparing" and "on stage".
- **Bottom bar:** Master (180 px: "MASTER" and the value over a 32 px track), a divider, "FLASH" with All and a short name per group (the first word of its name), then Undo (icon and word), **Safe · Basic lights** (a faint warm edge), Next ▸ over the next item's name, and Blackout (hold 1 s). 52 px high, 8 px apart. When Flash doesn't fit on the line (`bar-two-rows`, also always on an upright iPad), Flash gets its own line above the rest.
- **Operational states**, each different:
  - On stage: blue tint and edge (running order); "On stage" over the name in the top bar, "● changed" in amber.
  - Flash held: blue tint and edge; the top bar notes "Flash: …".
  - Master below 100 %: amber value and an amber fill.
  - Blackout: red tint at rest, filling red while held, stronger red while it's on. The top bar turns red: "Blackout" over "Lights are off" and "Tap a song or Basic lights to bring them back". The stage view says "Off".
  - Problems with the lights (Send DMX off, lights not answering, another desk sending): an amber pill in the top bar with a short label ("Problem" while preparing). A tap opens the explanation: what is wrong in plain words, that it isn't the volunteer's fault, **Who to call** (Settings; left out when empty), what still works, and Got it.
  - Live / Prepare: one segmented switch in the top bar (Live on: blue; Prepare on: violet). Prepare on: the whole top bar violet (11 % fill, 38 % edge) with "Preparing · the lights don't change" (violet small capitals) over the prepared item's name and a muted "On stage: <name>"; it wins over Blackout's red bar. **Go ▸** sits right after the switch and is the one blue control in the bar (blue tint, 70 % edge, 44 px). In the running order the prepared item is a violet tile (14 % fill, 50 % edge) with a violet "preparing", and the item on the real stage a dashed grey outline with "on stage". The stage view says "Draft · <name>" in small violet capitals at the bottom right ("Live" in muted capitals otherwise). The Groups subtitle says "<name> · draft", and Save is violet.

  Colour is only used where it says something.

## Audit notes (19 Oct 2026)

What the restyle fixed, from a read-through of all three pages before the work:

- **Tokens weren't shared.** The operator and settings pages each had their own, with different text, muted and danger colours; patch borrowed settings'. The operator page had 50+ one-off colours and 7 corner radii for objects at the same level.
- **"Selected" was drawn five different ways:** running order, tabs, preset tiles, segmented choices and the Fade menu. Quick-look tiles have no "current" state.
- **Held states** (Save, Blackout, Flash) each looked different.
- **Some operator targets were under 44 px:** the dimmers (40 px, now 44 px), the rename field (40 px, now 44 px) and the Master track (28 px, now 32 px inside a 58 px strip).
- **The operator toast was always red,** even for "Saved".
