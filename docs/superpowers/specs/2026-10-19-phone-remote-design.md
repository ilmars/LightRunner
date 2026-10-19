# Phone remote: design

Date: 19 Oct 2026. Status: agreed with Ilmārs and built (narrow-screen styles at the end of web/operator/style.css, the tab logic at the end of web/operator/app.js).

## Why

The live director wants the lights in their hand on a phone, as a **remote**. The iPad stays the full console. The phone only needs what's used during a service; rehearsal setup stays on the iPad.

## How it switches

The operator page (`/operator/`) picks the phone layout on narrow screens: under 700 px wide, or under 500 px tall (a phone on its side). On its side, the tab's content is on the left and Master and the dock are a column on the right. Same server, same commands, same state; the iPad layout is unchanged. Style: the design system (dark navy soft glass, docs/design-system.md).

## Layout (portrait, e.g. 390 × 844)

From top to bottom:

1. **Top line:** what's on stage (name), the amber "changed" mark, and a small status dot. The dot is amber when DMX output is inactive or there's a problem with the lights; tapping it shows the explanation, the same text as the iPad's status pill.
2. **Tabs:** Order · Groups · Looks (a segmented control). Opens on Order.
3. **Tab content** (scrolls when long):
   - **Order:** the running order in large rows (at least 52 px). Tap to start (Basic lights sends Safe, as on the iPad). The item on stage is blue glass with a blue edge, "changed" shows on it, and the item Next will start shows "next". No Edit, no Add song.
   - **Groups:** each group's name, colour (swatch and name), level as a number, and its fill slider. Along the top, the Flash buttons (All, then one per group, hold), sharing the width; they are the same buttons as the iPad's bottom bar, moved here on the phone. Smoke machines show their Puff in their own row. Tapping a group's colour opens the colour picker as a full-width sheet. "Back to …" appears at the top when the stage has changed. No Save.
   - **Looks:** the quick looks in two columns, with the same Plain / Colours / Effects tabs as the iPad. Tapping one tries it on stage. No "Save stage as quick look".
4. **Master** (always visible, on every tab): a full-width Master fill slider with its value, just above the dock. Amber when below 100 %, as on the iPad.
5. **Dock** (always visible): Undo · Blackout (hold 1 s) · a wide Next showing the next item's name.

## Left out on the phone

Save, Save as quick look, Add song, editing the running order, the stage preview. A remote shouldn't change the prepared show by accident. These stay on the iPad.

## Behaviour

Nothing new on the server. Every control sends the same commands as the iPad's (look, safe, groupLevel, groupPreset, groupColour, flash, quickLook, master, undo, blackout, backToLook). Flash held on the phone is released when the phone disconnects, as for any tablet. Touch targets at least 44 px.

## Mockup

`.superpowers/brainstorm/phone-remote.html` (local, git-ignored; it shows Master inside the Groups tab, which was then moved above the dock as above).
