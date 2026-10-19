# Preview mode: design

Date: 19 Oct 2026. Status: agreed with Ilmārs, not built yet.

## Why

During rehearsal or a service, the live director wants to adjust a song's colours **without the stage changing**. Today every tap on the operator page is live: tapping a song starts it, and the details panel edits what's on stage, which then has to be saved into the song. That's right for running the service, but it means a later song can't be fixed while an earlier one is on stage.

## Goals

- Pick any running-order item and change its groups' colours and levels, while the stage keeps showing what it shows now.
- See what the item will look like before it goes on stage.
- Never block the live service: Master, Flash, Blackout, Undo and Next keep working on the real stage the whole time.

## Non-goals

- Previewing on the phone. The phone stays a remote; it has no Preview.
- Editing quick looks, presets or Basic lights' built-in light in Preview. Only running-order items.
- A second, "preview" output to real lights.

## Anti-goals

- Preview sending anything to the lights. If a Preview edit ever changes the stage, the feature has failed.
- Forgetting Preview is on and tapping a song that then doesn't start in the middle of a service, without the page making that obvious.

## How it works

### Turning it on and off

- A **Preview** switch in the top bar, next to the settings gear (decided). Quiet when off, like the other top-bar controls.
- While it's on, the top bar shows a quiet **Preview** strip, the way it does for Flash, so it can't be forgotten (my call, agreed in passing).
- Turning it off brings the details panel back to the live stage, as now.
- Preview is per tablet: turning it on on one iPad doesn't change another (my call; the server stays the single source of truth for the show and the stage, and only the selection is local).
- Preview and running-order Edit don't mix: turning one on turns the other off (my call).

### Running order in Preview

- Tapping an item **selects** it instead of starting it. The selected item has a quiet outline; the item on stage keeps its blue "on stage" look, so the two can't be confused (decided).
- Preview opens with the item on stage selected, or the item Next would start when nothing is (my call).
- Next still starts the next item on the real stage (decided: Next keeps working live).

### Details panel in Preview

- Shows the **selected item's** groups: their saved colours and levels, with the same group rows, colour picker and dimmer sliders as now (decided).
- Every change is **saved straight into the item** (decided), with nothing sent to the lights. There's no Save button and no "Back to" in Preview. Undo takes back the last change, as it does for other show edits.
  - This differs from the live flow, where a change only reaches the show on Save. That is deliberate: Preview has nothing on stage to save from.
- A group the item doesn't set shows as "not set" and can be given a colour (my call).
- Smoke groups aren't shown: songs never set smoke.
- Quick looks, when tapped in Preview, set the selected item's groups that the quick look lists, saved straight in, nothing on stage (my call: in Preview, everything in the details area works on the item).
- If the selected item is the one on stage, the stage still doesn't change. That item then shows "changed" (the stage differs from what's saved), and **Back to …**, after Preview is off, brings the stage to the edited version.

### Stage picture in Preview

- The little stage picture shows the **selected item as it will look** (decided), settled, at its saved colours and levels, not what's on stage.
- So that it can't be mistaken for the real stage, it carries a quiet "Preview" label (my call).
- Master doesn't dim the preview picture (my call: it shows the item, not the room).

### Settled after the builder check (my calls)

- **Groups an item doesn't set** keep what they have when the item starts, so the preview picture can't know them. It draws them dark grey with a "not set" note in the details row. Items saved with Save set every group, so this is rare.
- **Undo** stays the one shared list, as now. Each Preview change is one step: a tap, or a dimmer or colour-strip drag when the finger lifts. That way a drag across the strip never makes dozens of colours.
- **Basic lights** can be selected and its colours changed, like Save to Basic lights today. Its levels stay at full, as Save keeps them.
- **Effects** don't exist yet. When they come, the picture shows a still frame.
- **The item on stage** keeps running untouched while it is edited: no fade, no restart, and manual overrides stay. The show edit reaches the engine the way Save does now.
- **Hidden in Preview:** Save stage as quick look, and the colour list's Edit. Both work on other things than the selected item.
- **After a reload or reconnect** Preview is off.

## Constraints

- Every Preview edit is a `Command` through `App.command()` (CLAUDE.md). The server is the single source of truth; pages only display.
- The engine stays pure. The preview picture comes from the engine's logic, not a second copy of the colour maths on the page.
- Nothing in Preview may reach the DMX output.
- Design system, quiet controls, 44 px targets (CLAUDE.md, docs/design-system.md).

## Left to the builder

- The new commands for editing an item's group colour and level (or one command for both) and how the show file stores them, following "Saving stores the item's own copy" in the operator layout design: an edit never changes a preset or quick look that something else uses.
- How the preview picture is made: for example, a second pure `Engine` on the server that runs the selected item settled and returns its visualiser bytes, asked for by the page when the selection or the item changes.
- How the Preview strip, the outline and the "Preview" label look, within the design system.
- Dragging a dimmer in Preview may save once when the finger lifts, rather than on every move.
