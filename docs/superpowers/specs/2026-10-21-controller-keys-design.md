# Controller keys: design

Date: 21 Oct 2026. Status: agreed with Ilmārs (21 Oct). Task 11 of the restyle plan.

## Why

Today the APC mini has a fixed layout (running order on the top pad rows, each group's colours in its column, Flash and functions on the buttons, faders for the groups and Master). It needs no setup, but nothing can be changed, and any other MIDI controller does nothing. The owner wants to choose what each key does, on any controller, without it getting complicated.

## How it works for the volunteer

- **A key** is anything a MIDI controller sends: a pad or button (note on/off) or a fader or knob (control change). It is named by the device and its place, for example "APC mini · pad 3,2" or "nanoKONTROL · knob 5".
- **Learn, never type:** every place that takes a key has **Assign a key**. Tap it, press the key on the controller within 10 s, and it is taken. **Clear** removes it. Nobody types MIDI numbers.
- **One key, one job:** assigning a key that is already used moves it, with a quiet note ("Pad 3,2 was Song 4; it is now Prayer").

## Where keys are assigned

1. **Settings › Controller keys** (a card in the new look): the fixed actions, each with what its key is now and Assign / Clear.
   - Running the service: Next, Back to saved, Undo, Basic lights, Blackout (hold 1 s), Flash all (hold), Flash group N (hold).
   - Levels (faders and knobs): Master, each light group's dimmer, Fade time, both ways: a knob that sweeps the times, and a key per fade (Instant, 1, 2, 3, 5, 10 s, Auto).
   - Tempo: Tap, ×2, ÷2.
   - A **Devices** line lists the MIDI controllers connected to the server, with a switch to listen to each (all on by default).
   - **APC mini layout**: a switch "Use the standard APC mini layout for keys I haven't assigned" (on by default) and **Reset to the APC mini layout**.
2. **Songs**: in running-order Edit, each song (and Basic lights) has a **Key** chip beside its name: "Key: pad 1,3" or "＋ Key". Tapping it starts learning.
3. **Quick looks**: the quick-look Edit sheet gets a **Controller key** row with the same chip.
4. Colours and effects are not assigned one by one in this task. The APC mini's colour columns keep working through the standard layout.

## Rules

- What a key does is a Command through `App.command()`, as the iPad's buttons (the existing `DeviceAction` list grows by: a song by id, a quick look by id, fade time, tempo tap and steps).
- Keys act on the real stage, never on a tablet's Prepare draft (a controller isn't anyone's tablet), as the APC mini does today.
- Faders and knobs use pickup (they take over only once they pass the current level), as the APC mini's faders do today.
- A song or quick look that is deleted frees its key. A song that moves keeps its key (keys follow the song, not the place), unlike the standard layout's rows, which follow places.
- Keys are saved in the show file (so they travel with an export) under the operator settings.
- **Pad lights** only where the device is known: the APC mini (and mk2 colours). A pad assigned to a song lights like a running-order pad (on stage bright, next dim); a pad assigned to a quick look lights when the stage matches it. Other controllers get no lights.

## Not in this task

- Assigning keys from the phone; controller keys for single colours or effects; MIDI output to other controllers; MIDI clock; Stream Deck (it keeps using Companion's HTTP buttons, which can already call every action).

## Decided by the owner

1. A song keeps its own pad when the running order changes; the standard layout's top rows still follow the order by place.
2. Fade time: both a knob and a key per fade time.
