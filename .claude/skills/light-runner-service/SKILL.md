---
name: light-runner-service
description: Walk someone through preparing Light Runner for a church service and running the lights — starting the server on the church Mac, handing the lights over from Lightkey (Send DMX), the Art-Net node, iPads and the phone, the APC mini / controller keys / Stream Deck / OSC, the PIN, Who to call and backups — and check the running system for them. Use this whenever someone asks how to set up, start, prepare, check or run the lights, get ready for Sunday or a rehearsal, hand over from Lightkey, connect an iPad or the APC mini, or asks why the lights aren't working, even if they don't say "Light Runner" or "skill".
---

# Light Runner: setting up and running a service

You are helping a lighting lead or a volunteer at a church get the lights ready and run them. They are usually not technical, may be in a dark room, and may be in a hurry before a service. Talk in plain words, one step at a time, and wait for them to confirm a step before giving the next when they are doing it live.

The full people guide is `docs/running-a-service.md` — read it first; it is what you walk them through. Controllers are detailed in `docs/companion.md`. Facts about the rig are in `CLAUDE.md` ("The rig (stage L1)").

## First, find out where they are

Ask (or infer from what they said) which of these they need, then follow that part of the guide:

1. **Setting up** — first time, a new iPad, a new controller, after an update, at a new venue: guide Part 1.
2. **Before a service** — "getting ready", "is everything OK?": run the check below, then guide Part 2 "Before people arrive".
3. **During a service** — they need one thing fast ("how do I black out", "the lights went off"): answer that one thing in a sentence or two, nothing else.
4. **Something is wrong** — run the check, then use the table in guide Part 2 "When something is wrong".
5. **After the service / handing back to Lightkey**: guide Part 2 "After the service".

## The check (read-only)

When the server is reachable from where you run, check it before advising:

```bash
node .claude/skills/light-runner-service/scripts/check.ts http://localhost:8080
```

Use the address they use (on the church Mac `http://localhost:8080`; from elsewhere `http://192.168.0.195:8080`). On the church Mac, `node` may need to be `/opt/homebrew/opt/node@24/bin/node`. The script only reads; it reports whether Light Runner answers, whether it is sending to the lights (and the problem in plain words if not), what is on stage, Master below full, held individual lights, the groups, Who to call, and the APC mini. Tell them the result in your own short words and what to do about each ✗ — don't paste the raw output at them.

If it doesn't answer: Light Runner isn't started, the Terminal window was closed, or the address is wrong. Starting it is guide Part 1 step 2.

## What you may do, and what you ask first

The lights are real and people may be in the room, so:

- **Reading is fine** (the check, `GET` requests, reading files, `npm test`).
- **Ask before anything that changes the stage or the show**: turning Send DMX on or off, starting a song, Blackout, changing settings, importing a show, restoring a backup. Usually it is better to tell them which button to press, so they stay in control.
- **Never start a second Light Runner** pointing at the same `data/` folder as the one running the service, and never stop the running one during a service without asking.
- **Away from the rig** (testing at home), start it with `LIGHT_RUNNER_OUTPUT=none` so it can't send to lights.
- **Lightkey and Light Runner must never send to the node at the same time.** Light Runner takes over with Send DMX on only after Lightkey's output is off; Lightkey takes back after Send DMX is off.
- **The PIN** is the programmer's; never print it, ask for it in chat, or put it in a command. If they need Settings, they type it on the page.

## Things people often get wrong

- Closing the Terminal window on the Mac stops Light Runner (and the lights stay on their last look; the iPads show "Connection lost").
- The amber pill on the operator page explains itself when tapped, and shows Who to call.
- Blackout needs a 1 second hold and doesn't toggle: a song, Basic lights or Next brings the lights back.
- Prepare (violet) changes nothing on stage until Go; Live throws the draft away.
- The APC mini needs no setup (its standard layout); its faders "pick up" — they do nothing until moved to the current level.
- A key for a song is set in running-order Edit list; the fixed actions (Blackout, Next, Master…) in Settings with the PIN.

## Not built yet (say so, don't improvise)

Light Runner doesn't start by itself when the Mac starts — someone starts it in Terminal (see `docs/STATUS.md`, "Not built yet"). If they ask for that, explain it's planned and how to start it by hand meanwhile.
