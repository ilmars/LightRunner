# APC mini, Stream Deck (Companion) and OSC: design

Date: 20 Oct 2026. Status: agreed with Ilmārs (proposal approved as written), not built yet. The owner has an Akai APC mini (model to be confirmed: the older one or the mk2) and a Stream Deck run by Bitfocus Companion. He tests the hardware later; it is built and tested here against simulated devices.

## What the devices do

The same things, everywhere: change the running order (start a song or Basic lights, Next), fade each light group, change each group's colour, Master, Flash, Blackout. Everything goes through the same Commands as the iPad (`App.command()`), so the iPads and the devices always agree.

## APC mini (USB MIDI on the server computer)

Each pad column sits above its fader, so a column is a light group (the operator page's group order, light groups only; smoke groups are left out).

| Part | Does |
| --- | --- |
| Faders 1–8 | Group dimmers (groups 1–8) |
| Fader 9 | Master |
| Top 2 pad rows (16 pads) | Running order (Basic lights, Song 1, …). On stage: bright; next: dim; others: low |
| Lower 6 pad rows | Colours: column N = group N's first 6 colours (the colour list, effects not included). Tap to run; running colour bright, others dim |
| Buttons under the pads (8) | Flash group N (hold) |
| Buttons on the right (8, top to bottom) | Next · Back to · Undo · Basic lights · Flash all (hold) · Blackout (hold 1 s; tap while blacked out brings the lights back like the iPad's Blackout) · (spare) · (spare) |

- **mk2 vs older model** *(my call)*: found from the MIDI port name. The mk2's pads show each colour's real colour (RGB); the older model shows state with its green/red/yellow LEDs (on stage/running: green; next: yellow; available: dim/blinking as the hardware allows).
- **Pickup faders** *(my call)*: a fader only takes over once it passes the group's (or Master's) current level, so moving it never makes a light jump.
- **Unplugging / plugging in**: Flash held from the APC stops when it is unplugged (as for a tablet that drops off); the server looks for the APC every 2 s and picks it up again.
- **Feedback**: pads and button LEDs always show the live stage (changes from any iPad included).
- **Never on the draft**: the APC always works on the real stage (Blind is per iPad).

## Stream Deck through Companion

Companion's built-in "Generic HTTP" connection talks to Light Runner over the network *(my call: no Companion plugin to maintain)*.

- **Buttons** (HTTP POST): start running-order item N, Next, Back to, Basic lights, Blackout, Undo, Flash group N on/off (press/release), group N colour K, group N level, Master (value, up, down).
- **Feedback**: `GET /api/companion` returns a small flat JSON status that Companion polls (e.g. twice a second) into variables: the song on stage and the next one, Master, Blackout, Flash, each group's colour name and level, tempo.
- **Guide**: `docs/companion.md` lists the addresses for each button and how to set up the polling.

## OSC

- The same actions as OSC messages over UDP (e.g. `/lightrunner/next`, `/lightrunner/item 3`, `/lightrunner/group/2/level 0.5`, `/lightrunner/group/2/colour 4`, `/lightrunner/flash/2 1`, `/lightrunner/master 0.8`, `/lightrunner/blackout`).
- Off until switched on in Settings, with a port (default 8000). Input only *(my call; feedback over OSC can come later)*.

## Not in this

- Companion plugin, MIDI on other controllers, OSC feedback, MIDI clock or tap tempo from the APC.
- Running on a Raspberry Pi (likely fine, its own task).

## Constraints

- Every input becomes a Command through `App.command()`, role "operator" (the same rights as the iPad).
- Local network only (as the HTTP API today).
- The MIDI add-on (`@julusian/midi`) is an optional dependency: without it (or without an APC) Light Runner runs as now.
- Tests run without hardware (a simulated MIDI port, a local UDP socket).
- Plain words in Settings and docs.
