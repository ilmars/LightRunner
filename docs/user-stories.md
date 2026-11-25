# User stories: the new operator page

Gathered from the design talk on 25 Nov 2026 and agreed the same day. The decisions are also in [DECISIONS.md](DECISIONS.md) (25 Nov).

## The problem

Setting up (Patch, Settings) works well, and so does the stage view. Running the show and changing things live is harder: it takes too many clicks to get a result, it isn't always clear what a look or cue will do, and looks and cues change everything at once, so changing one light or one group is awkward.

## Design rules

1. **Simple to use, deep to set up.** Running is one or two taps; detail (colours, effects) lives in setup.
2. **Pick who, then one press.** Choose a light or group, then one press for a colour, an effect or a look.
3. **Few controls on screen.** More appears only when asked for (the faders, for example).
4. **Never a copy of Lightkey.** If a screen starts to look or work like Lightkey, stop and rethink it.
5. **Always clear what will happen**, and whether you are working live or preparing.

## What to keep from today's Light Runner

- Patch and Settings as they are.
- The stage view.
- Looks and cues (the running order) as ideas, with changes to how you reach them and how clearly they show what they do.
- Fading on Go uses the current fade time.

## Page designs

All new pages at iPad size, in Home A's style, toned down for a dark room: [Light Runner: new operator pages](https://claude.ai/artifact/GKgenzWLuP2cyTPu3qCDPD) (private canvas). Live (Full and Simple), Prepare, faders, running an effect, the song list, and the setup pages: build an effect, a song's colour square, arranging panels, controller learning.

## Design references (canvas: Light control: free explorations)

| Take | From | What |
| --- | --- | --- |
| Main screen layout | Home A · Stage and pads | Stage preview and pads in front; cues, groups and the colour picker one tap away |
| Panels you arrange | Home C · Bento | Move, resize, show and hide panels without changing code |
| Look pads | Orbit + Pads | One press is one look |
| Colour square | Morph | Four corner colours you choose by dragging; a spot in the square is a mix |
| Building effects | App · Patchbay | Colours → movement → speed → name |
| Running effects | Weather | Pick from a short list, set speed, freeze |
| Later, maybe | Orbit + Pads beat strip | Choosing the beats an effect fires on |
| Not wanted | Orbit colour wheel; anything Lightkey-like | |

## Stories

### Main screen and looks

1. **As an** operator, **I want to** see the stage in the middle with group buttons under it, **so that** I can pick a group and colour it or give it an effect right there.
2. **As an** operator, **I want to** press a look pad once to get that look, **so that** switching is instant.
3. **As an** operator, **I want to** apply a look to only the lights or group I picked, **so that** I can mix looks without changing everything.
4. **As an** operator, **I want to** open the dimmer faders only when I need them, **so that** the screen stays simple the rest of the time.
5. **As an** operator, **I want to** move, resize, show and hide panels, **so that** I can shape the layout to how I work without anyone changing the code.

### Colour

6. **As an** operator, **I want to** pick a light or group and tap a colour on the colour square, **so that** I can recolour just that part in two taps.
7. **As a** lighting lead, **I want to** choose the square's four corner colours by dragging colours onto it, **so that** the square holds the right colours for this show or song.

### Building effects

8. **As a** lighting lead, **I want to** build an effect from colours, a movement and a speed, then name it, **so that** I can use it again with one press.
9. **As an** operator, **I want to** change an effect's colours without rebuilding it, **so that** one effect works for many songs.

### Running effects

10. **As an** operator, while a cue is running, **I want to** pick the background and start an effect on it in one or two taps, **so that** I can add energy without leaving the running order.
11. **As an** operator, **I want to** run an effect on a group by picking it from a short list and setting its speed, **so that** live control takes one or two moves.
12. **As an** operator, **I want to** freeze a running effect, **so that** I can hold an exact moment and then let it carry on.

### How long a change lasts

13. **As an** operator, **I want to** hold a pad to run an effect and have the lights go back when I let go, **so that** I can add short accents (a flash is one of these) safely.
14. **As an** operator, **I want to** choose how long an effect lasts, **so that** it can end by itself.
14a. **As an** operator, **I want to** pin an effect, **so that** it keeps running through Next until I turn it off.

The model behind 13–14a: every action is **who + what + how long**. How long is *hold* (while pressed), *stay* (until turned off or the next cue), *pinned* (until turned off, through Next) or *for a while* (a set number of beats at the stage tempo). Layers, from bottom to top: the cue's look, live changes on picked lights, holds.

### Cues, Live and Prepare

15. **As an** operator, **I want to** see what the next cue will change before I press Next, **so that** I'm never surprised by what the stage does.
16. **As an** operator, **I want to** press a pad and see the stage change at once, **so that** quick changes need no extra step.
17. **As an** operator, **I want to** prepare changes in the preview without touching the stage, then send them all with Go, **so that** I can set up the next moment calmly.
18. **As an** operator, **I want to** step ahead to a cue in Prepare, change it and save it, then send it with Go or go back, **so that** I can fix upcoming cues during the service without the stage changing.
19. **As an** operator, **I want to** always see whether I'm in Live or Prepare, **so that** I never change the stage by accident.
20. **As an** operator, **I want** Go to fade using the current fade time, **so that** prepared changes reach the stage as smoothly as any other change.

### Hardware

21. **As an** operator, **I want to** pick colours and control effects from a hardware fader or button, **so that** I can play the lights without looking at the screen.
22. **As an** operator using a MIDI controller, **I want** the Prepare button to switch on and off with one press, **so that** I don't have to hold it while I work.

## Decided

- **Getting into Prepare:** on the screen you hold the Prepare button while you work; on a MIDI controller one press switches it on and off.
- **Prepare and cues:** press Prepare, step to a cue, change it, save it, then Go live or go back.
- **Fading on Go:** uses the current fade time, as Light Runner does today.
- **Effects and Next:** Next clears effects you started yourself, so every cue looks the way it was saved. To keep an effect across cues, you pin it; it stays until you turn it off.
- **Which effects are live:** only favourites picked during setup (about 6–8); a small "more" opens the full list.
- **"For a while":** counted in beats, using the stage tempo (tap tempo, ×2 / ÷2, a song's own tempo) Light Runner already has. A few steps to pick from, such as 4, 8, 16 and 32 beats.
- **Many cues:** grouped by song. The cue strip shows only the current song's steps, with the song name and the next song at its edges; a song list opens to jump anywhere. The song order can come from the planned service.

- **Faders:** one per group, each with a small arrow that opens faders for that group's single lights. They slide up over the lower part of the stage view and close when you tap elsewhere.
- **New effects:** naming an effect doesn't put it on the pads; saving it offers one tick, "Add to favourites".
- **MIDI set-up:** learning: press Learn, touch the control, tap the thing on screen. Settings lists every link to check or delete.
- **Panel layouts:** saved per device; the church iPad keeps its layout whoever holds it. A device can also switch between two layouts, **Simple** and **Full**, so a new volunteer gets the simple one without a login.
- **Colour square:** when the song changes, the square's four corners change with it. A song without its own corners uses the show's.
- **Holding Prepare on screen:** a short hold is a quick peek; a long press (about 1 s) locks Prepare on, and one tap turns it off. While Prepare is on, the screen gets a clear frame and label.
- **Style:** Home A's look (near-black, flat panels, Inter Tight, pill buttons, colour-filled look pads, a stage preview with light beams), toned down: picked things get a faint light fill, Go and the current step a dim orange.
- **Main screen:** four parts: cues, the colour picker, pads and groups. Home A's straightforward look is the base (stage preview and pads in front), with cues and groups always one tap away. Home D is no longer a separate reference.

## Build order

1. **The whole main page first**, matching the design: start with the layout (stage preview with beams, who row, pads, colour square, the song's steps with Next and Blackout), then make each part work. No picking stories one by one for this page.
2. Effects: building, favourites, how long, freeze.
3. Arranging panels (Simple and Full).
4. Controller learning.

## Open questions

None left.
