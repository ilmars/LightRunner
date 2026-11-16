# Auto-follow: what to try at the church

16 Nov 2026 · a check list for the church Mac with the presentation app open · design: [song sections](../superpowers/specs/2026-11-16-song-sections-design.md)

Auto-follow and sections were built and tested on a PC against a fake presentation app made from a recording. The live part can only be tried where the planning login and a presentation computer are. Do this at a rehearsal, with **Send DMX off** (or the launcher's Test mode) so nothing reaches the lights, and watch the stage view. Write down what you see in the "Write down" column, or in the answers at the end, and put them in [STATUS.md](../STATUS.md) afterwards.

**Before you start**

- Planning is on in Settings and says "Logged in · works". **Load service** for the Sunday you will try. Open the same service in the presentation app.
- Auto-follow is **off** (the pill after the name says "○ Auto-follow off"). Leave it off until a step says to switch it on.
- Open the operator page on the iPad and look at the section rows under a song: tap a song, and see its facts line ("G · 72 bpm · 6/8") and its sections.

## 1. Each row of the table

Switch Auto-follow on (tap the pill: it should say "● Auto-follow", and start what the presenter has on screen). Then move through the service in the presentation app and check each row:

| Do this in the presentation app | The lights should | Write down |
| --- | --- | --- |
| Go to a new song (its first slide) | start that song's look, fading | Yes / No. Fade right? |
| Go to a part's first item (a new header, such as the sermon) | start the part's look, if it has one | |
| Go to a song's blank slide (every song starts on one) | start the song's own look | |
| Click to a slide of a section (verse, chorus), not the one on stage | start that section's look, or the song's when it has none | |
| Click to another slide of the section already on stage (Chorus b after Chorus a) | change nothing | |
| Click to a slide with no section (an untitled "Slide 11") | change nothing | |
| Go to a Bible verse | change nothing | |
| Go to an item that isn't in the running order (load an older plan, or type one) | change nothing; the pill says "not in the running order" | |
| Go back to the chorus after a verse | start the chorus look again | |

The pill should name the song and the section while on ("● Auto-follow · Chorus").

## 2. A tap by hand pauses it

With Auto-follow on, tap a song row on the iPad. The pill should say "○ Auto-follow off" on every tablet, and the next slide in the presentation app should change nothing. Switch it on again and it should start what is on screen. Switch Auto-follow on with the presentation app closed: nothing should change. Check that **Master**, **Flash**, **Undo** and a group's colour or level do **not** pause it, and that Blackout, Next and a quick look do.

## 3. What the presentation app sends (these are not known yet)

Write down what the lights and the pill do for each. Until we know, nothing is meant to change for them.

| Do this | Write down |
| --- | --- |
| **Blank** the screen in the presentation app | Does anything change? What does the pill say? |
| **Black** (clear to black) | |
| **Clear all** | |
| Does a refused channel (the presentation app can't join its live channel) show a plain reason in the pill? How do you make it happen (log out, no internet)? | |

## 4. A click in the presentation app's own window

The recording we built from only had a remote's clicks. Click through slides with the mouse in the presentation app's own window (not a remote), and check that the lights follow the same way. Write down whether anything differs.

## 5. A reconnect

With Auto-follow on, switch the Mac's Wi-Fi off for a minute (or unplug the cable) and on again. The pill should say why it stopped ("○ …") and come back to "● Auto-follow" by itself. Then click to the next slide and check it follows. Also restart Light Runner while a song is on screen: after it starts, switching Auto-follow on should start what is on screen.

## 6. Two computers open

Open the same service in the presentation app on a second computer (the one for the live stream, say). Move on one and then the other. Write down whether the lights follow the one that moved last, and whether they ever jump back.

## 7. Auto-advance

Does Rīga use auto-advance (a slide that moves on by itself after some seconds)? If so, check that the lights change when it moves on, without anyone clicking. That is meant, but worth knowing before a service.

## 8. Where the chords are

Chords aren't read yet because it isn't known where the song library keeps them. Look at one song in the planning service on the church Mac, and write down **field names only** (as the 4 Nov research did, and never any lyrics): are the chords marks inside the slide text, or a separate chord chart? What is the field called, and what does a chord line look like in general (for example "a row of chord names above each line")? Then the chords can be read, and planning can use them.

## What to write down at the end

- Each "Write down" cell above, and anything that surprised you.
- Whether a fade was ever a jump, and whether any step moved the lights when it shouldn't (a Bible verse, a slide of no section).
- How long a reconnect took.
- Whether you would switch Auto-follow on for a Sunday, and what you would want changed first.

Update [STATUS.md](../STATUS.md): take the items off the Known issues list that are settled, and add what you found.
