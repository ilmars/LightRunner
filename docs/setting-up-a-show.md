# Setting up a show

A plain guide for the lighting lead (the programmer) at stage L1: how to take Light Runner from its demo show, or an empty one, to a show that is ready for Sunday. Everything here is done on the three pages, with no code and no files to edit. Setting up the computer, the iPads and the controllers, and running a service, are in [running-a-service.md](running-a-service.md); the Stream Deck and OSC are in [companion.md](companion.md).

**The pages:** the top bar of each has links to **Operator** (the volunteers' page, where songs, colours and effects are made), **Patch** (the lights and the stage plan) and **Settings** (output, backups and keys). They are at `http://192.168.0.195:8080/operator/`, `/patch/` and `/settings/` (use `localhost` on the Mac itself).

## 1. Before you start

1. **Open Patch or Settings.** If a programmer PIN is set, type it and press **Unlock**. (Set one in Settings › Programmer PIN, 4 to 6 digits; see the service guide.)
2. **Build with the lights off.** While you build, switch on **Options › Test mode: don't send to the lights** in the Light Runner window, or switch **Send DMX** off in Settings › DMX output. The stage view on the operator page keeps showing what the lights would do. Switch Send DMX on for a moment only when you want to see a light respond (Identify in step 2, the final check in step 10), and only when Lightkey isn't sending.
3. **Keep a copy first.** In Settings › Show press **Export show file** and keep the file. **Open a show file…** brings it back (it replaces the whole show; the current one is kept as a backup). Light Runner also keeps the last 20 saves under Settings › Show › Backups, each with a **Restore** button. Do this again before any big change.
4. **Choose your route.**
   - **A Lightkey project.** This is the fastest way to get the lights in.
     1. In Settings › Show press **Compare with a file…** and choose the `.lightkeyproj`.
     2. It brings in the fixture types and the fixtures: their names, DMX addresses and places on the stage plan. It does not bring in groups, colours, songs, quick looks or effects; you make those below.
     3. You see what is new or changed. Tick what to take (new and changed items are ticked, removals are not) and press **Apply selected**. The current show is kept as a backup, and the PIN and output settings are not touched.
     4. Carry on at step 2, from "Groups". Lightkey and Light Runner must still never send to the node at the same time.
   - **By hand.** A fresh install starts with a small demo rig (a few groups, a handful of songs) that isn't connected to anything. Reuse its groups by renaming them, or delete its fixtures and groups in Patch and start clean. Carry on at step 2.
   - A whole show built from a Lightkey project with its groups, colours and starter songs is done by a command-line tool; ask whoever maintains Light Runner.

## 2. Patch: the lights and the groups

Open **Patch**. Changes stay in the page until you press **Save patch** in the bar at the bottom (it says "Unsaved changes", with **Discard** beside it). Nothing reaches the show before that.

**Find the fixture type** (the make and model, with the DMX mode it is set to):

1. The first time, open Settings › Fixture database and press **Download database (about 3 MB)**. Patch can then search the whole Open Fixture Library without internet.
2. In Patch, under **Open Fixture Library**, type the model (for example `SonicPulse`) and press **Search**, or choose a maker under **Browse by manufacturer…**.
3. Tap the fixture, then tap the **DMX mode** the fixture is really set to (for example "23-channel · 23 ch"). The channel count must match the mode set on the light itself. The type now appears in the **Fixture library** list and is picked in **Add fixtures**.
4. A fixture type from a Lightkey project arrives with the project (step 1). **Import fixture file…** takes a fixture file in the Open Fixture Library's format. A light that is in none of these gets a type you make yourself (below).

**Add the lights:**

1. Under **Add fixtures** choose the **Type**, type a **Name**, set **How many**, the **Universe** and the **Start address**. A universe is one block of 512 DMX channels and must be the one the node sends out (at L1 it is 1; the demo show uses 0). Light Runner suggests the first free address; the line under the form shows the channels it will use, such as "1 × 23 channels: 57–79". With several, they are named "Bar 1", "Bar 2" and so on, and follow each other.
2. Press **Add**. Or drag a type from the **Fixture library** onto a free channel in the **DMX patch** map, or tap a free channel to fill in its address.
3. Check the map. The **Universe** tabs above it pick which universe you see (**＋** shows the next one), and the map shows every channel in it. Fixtures in the same colour are the same type.
   - Overlaps, and fixtures that run past channel 512, turn red, and the table says "N fixtures have address problems".
   - Drag a fixture in the map to move it to other addresses.
4. In the **Fixtures** table you can rename a light, change its **Type**, **Universe** or **Address**, and delete it. **Channels** shows the range and how many segments a bar has. Switch **Reversed** on for a bar hung the other way round, so its first segment is at the other end.
5. **Identify** (after **Save patch**) flashes that one light white for 3 seconds, so you can find it in the room and see that its address is right. It needs Send DMX on.

**Groups.** A group is what the operator page controls: Front lights, Back wall, and so on.

1. Under **Groups**, type a name next to **New group name** and press **＋ Add group**. Each group shows on the operator page.
2. In the group, choose **＋ Add fixture…** to put a light in it. A light can be in several groups. Under each name, **‹** and **›** move it earlier or later and **×** takes it out.
3. The order matters: waves and chases run along the group in that order, left to right. Put the lights in the order they hang.
4. A smoke or haze machine gets its own group with **Smoke or haze machine** switched on. Songs, quick looks, Basic lights and Flash leave it alone; the operator page gives it its own slider and **Puff**.
5. Press **Save patch**. **Delete group** also deletes the group's colours and takes the group out of songs and quick looks, so use it carefully.

**A fixture that is in neither the Open Fixture Library nor a Lightkey project.** Make its type yourself in Patch:

1. Press **＋ New fixture type** above the **Fixture library** list. Type a **Name**.
2. Choose **＋ Add channel…** once for each of the light's channels, in the order the light uses them. Give each a job: **Dimmer**, **Red**, **Green**, **Blue**, **White**, **Amber**, **UV**, **Colour temperature**, **Strobe** or **Fixed value**. Use the light's manual for the order. **↑** and **↓** move a channel and **×** takes it out.
3. Switch **16-bit** on for a channel that takes two DMX channels (it uses the next one as well). For **Colour temperature**, type the light's **Warm end** and **Cool end** in K. For **Strobe** and **Fixed value**, type the **Value** (0 to 255) that holds the channel where you want it. A light made of several identical segments: add the first segment, then tap **Repeat the last segment** for each more.
4. The line under the channels sums it up: how many channels, whether it is one light or several segments, and what they do. Under **Use it for**, tick the fixtures that should switch to this type. They keep their names, addresses, groups and places on the plan.
5. Press **Save type**, then **Save patch**. Nothing reaches the show before that; **Discard** throws it away.

**Look at a type, or find a substitute.** **Channels ›** under the Fixture library list (for the type you picked), and the **›** beside a fixture's **Type** in the Fixtures table, open that type's channels: a summary, "Used by N fixtures", and the numbered channels. **Compare with…** shows two types side by side, with the channels that differ tinted and "—" where one type has no such channel. Use it to check that a type you have is close enough to a light you don't have a type for.

**Change a type.** **Copy and edit** makes your own copy of any type and opens it in the editor; **Edit** changes one of your own. Types from the Open Fixture Library or a fixture file, and the built-in Generic types, can't be changed, so copy them. A type that came from a Lightkey project can be edited. In the editor the fixtures already using the type are shown and locked; they follow every change. To move one to another type, change its **Type** in the Fixtures table. **Delete type** (tap it twice) is there only when no fixture uses the type. Press **Save type** or **Cancel** before **Save patch**.

*Example.* The church's front panels P1–P4 are walimex pro LED Niova 600 Plus Bi Color lights patched with the Neewer AS600B (2 channels: dimmer and colour temperature, 2500 to 10000 K) as a substitute. The walimex only goes from 3200 to 5600 K. To say so: pick the AS600B in the Fixture library, press **Channels ›**, then **Copy and edit**. Rename it, set **Warm end** to 3200 and **Cool end** to 5600, tick P1–P4 under **Use it for**, press **Save type**, then **Save patch**.

Other routes:

- Use one of the built-in **Generic** types if the light's channels are in the same order: Generic dimmer (1 ch), RGB (3), RGBW (4), RGBA (4), dimmer + RGB (4), dimmer + RGBW + strobe (6) and 16-bit dimmer + RGBW (6). It works only when the light's own channels really are those, in that order; otherwise colours will be wrong.
- If the light is in a Lightkey project, use **Compare with a file…** (step 1); the type comes from Lightkey.
- Describe it in the Open Fixture Library's online fixture editor (open-fixture-library.org, "Add fixture"), download the file it makes, and bring it in with **Import fixture file…**. Someone may also simply give you such a file.

## 3. The stage plan

At the bottom of Patch, **Stage plan** is a picture of the stage with the back at the top. The operator page's stage view is drawn from it, so it shows what the lights are doing.

1. **Drag** a light to where it hangs. A new light starts in the middle of the plan (several new ones start in a row).
2. **Click** a light to change it. Choose its shape: **Dot**, **Beam**, **Bar**, **Outline** or **Smoke**. A fixture with several segments arrives as a bar; for any other, choose the shape you want.
3. What each shape gives you to drag:
   - A **Bar** has a handle at each end (length), one on a long side (thickness) and one past the end to turn it. **Across** and **Upright** snap it flat or upright, and its angle shows beside them.
   - A **Beam** has a round handle at its tip: drag it to aim the beam and set how far it reaches.
   - An **Outline** (a strip round something) has a corner handle for its size.
   - Hold **Shift** while turning or aiming to move freely.
4. To line lights up, **Shift-click** several, or drag a box round them. Then use **Align** (**Left**, **Centre**, **Right**, **Top**, **Middle**, **Bottom**) and **Space evenly** (**Across**, **Down**, for three or more). **Escape** lets go of the selection.
5. Click an empty spot and choose **＋ Add fixture here** to patch new lights there; the **Add fixtures here** form has the same fields as **Add fixtures**, then **Add** (or **Cancel**).
6. Press **Save patch**.

## 4. Output: where the commands go

In Settings › **DMX output**:

1. Choose the **Output type**: **Art-Net** (the church's node), **sACN (E1.31)** or **ENTTEC USB**.
2. For Art-Net, type the **Node IP address** (at L1: 192.168.0.114), or press **Find nodes** and **Use** beside the node. Set the **Universe** to the one the node listens on (at L1: 1); this field is shown while the show uses one universe.
3. With several universes, the **Universes** list shows each one's number, how many fixtures are on it, and whether it uses the default output or **Use its own output**. **＋ Add a universe** adds a number; a universe that isn't sent says why.
4. For sACN choose **Multicast** or **One receiver** (and type its address); the **Priority** of 100 is normal. For ENTTEC USB choose the **USB port**; it sends one universe.
5. Press **Save** in the bar at the bottom.
6. **Send DMX** takes effect at once, without Save. It is how Light Runner takes the lights from Lightkey and gives them back; see "Lightkey and Light Runner" in [running-a-service.md](running-a-service.md#lightkey-and-light-runner). Leave **Engine** (frame rate, dimming curve) as it is.

## 5. Colours

On the operator page each group has its own colour list, used on the **Groups** panel.

1. Tap a group's colour button to open the picker. It has **Colours** and **Effects** tabs, **‹ Groups** and **Done**.
2. A group made in Patch starts with two colours, **Warm white** and **Off**. Tap **＋ New colour** to add more. The stage doesn't change while you try colours here.
   - Give it a **Name**, then pick the **Colour** on the strip (a white-only group has a warm-to-cool strip instead).
   - **Saturation** makes it paler or stronger. **Exact values ›** takes a hex code or R, G and B. A group with White, Amber or UV also has a slider for each.
   - **Brightness** sets how bright it is (5 to 100 %), and **Fade into it** how long it takes to fade in.
   - **Apply to** says whether it is for **Only <the group>** or **Every colour group**.
   - Press **Save**; it is added to the group's list.
3. In the picker, **tap** a colour to fade the group to it. **Hold** it, or tap it and then **Edit this colour**, to change its name, colour or fade. **Delete colour** needs a second tap, and is refused while a song or quick look uses the colour.
4. **Any colour** lets you drag along the strip to try a colour live; **＋ Keep as a colour** keeps it in the list.
5. **Basic lights** is the safe look, always first in the running order, and the **Safe · Basic lights** button always brings it back. It runs a built-in warm light until you set your own: tap **Basic lights**, set each group, then hold **Save to Basic lights** for 1 second. It is always full and always still, and it is how you recover when something looks wrong.

## 6. Songs and the running order

A song is one saved picture of the stage: every group's colour, level and effect, and the tempo. The **Running order** lists Basic lights first, then the songs.

1. **Make a song from the stage.** Get the stage looking right (start Basic lights or a song, then change groups' colours, levels and effects). Then tap **＋ Add song** under the list. A new "Song N" holding the stage appears after the one on stage (at the end when nothing is on stage).
2. **Change a song.** Start it, change the stage, then hold **Save to <song>** for 1 second. The button is at the top of **Groups**; **Back to saved** next to it throws the changes away.
3. Tap **Edit list** to rename (tap the name and type; Enter finishes), drag **≡** to reorder (Basic lights stays first), or delete with **⊖** and then **Delete** (the second tap). Press **Done** when finished. Tapping a song does nothing while you edit.
4. Songs have no sections or times of their own. **Fade** in the top bar sets how long changes take: **Auto** (each song's and colour's own), **Instant**, 1, 2, 3, 5 or 10 s. A colour's own fade is its **Fade into it**.

## 7. Quick looks

A quick look changes only some groups (say the back wall to turquoise) and leaves the others alone. They sit at the top right, on the **Plain**, **Colours** and **Effects** tabs. The tab only decides where the button is shown.

1. Set the stage as you want it, then tap **＋ Save stage as a look** (the last tile).
2. In **New quick look from the stage**, type a **Name**, choose the **Tab**, and tap any group you don't want it to set (it becomes "left out" and keeps whatever it has). Press **Save**.
3. To change one, press **Edit looks**, then tap the quick look. **Edit quick look** lets you rename it, move it to another tab, add or leave out groups, switch on **Update from the stage** to replace what it gives with the stage as it is now, or **Delete** (tap twice). Press **Done**. In edit mode you can hold a quick look and drag it onto another to give it that place.
4. Smoke groups are never offered.

## 8. Effects

Effects are moving looks for a line of lights: colour fade, wave, chase and so on. Each group has its own effects.

1. Tap a group's colour button, then the **Effects** tab. A group of one light says "Effects need a line of lights" and names the groups that can run them.
2. **Tap** an effect to run it on that group. While it runs, a card shows its **Speed** and **All settings ›**. **Hold** an effect, or tap **＋ New effect**, to open the effect editor. A strip at the top shows the effect moving along the group; the stage doesn't change until you press **Save**.
3. In the editor, from the top:
   - **Name**, and **Effect**: **Colour fade**, **Wave**, **Chase**, **Sparkle**, **Breathe**, **Meteor**, **Fill** or **Yo-yo**.
   - **Colours**: 1 to 6, numbered in the order they play. Hold one and drag it onto another to reorder. **＋ Colour** adds or removes colours from the group's list, and **＋ Own colour** makes a new one. Meteor and Yo-yo use one colour.
   - **Base**: **None**, **Colour** or **Own colour**, with its brightness. It is a colour under the effect, where the effect is dark.
   - **Speed** and **Direction** (**Left → right**, **Right → left**, **Centre out**, **Outside in**).
   - **Fine-tune**: **Waves at once**, the **Size** (called Amount, Depth or Tail for some effects) and **Edges**, **Soft** or **Hard**. Only what the chosen effect uses is shown.
4. **Speed** is how many beats one round takes: 1, 2, 4, 8, 16 or 32, or **Free** in seconds. The line beside it says how long a round is at the current tempo.
5. **⋯** has **Save as a copy** and **Delete** (a second tap; refused while a song or quick look uses it). **Save** adds the effect to the group's list; tap it there to run it.
6. **Tempo** is in the top bar. Tap it to type a number (Enter or the keyboard's Done sets it, 40 to 240) or use **×2**, **÷2**, **−** and **+**; or tap **Tap** along with the music. A song keeps the tempo it was saved with.
7. To keep effects in a song, run them on the groups (tap the effect on each group), then **＋ Add song** or hold **Save to <song>**. For a quick look, do the same and use its **Effects** tab.
8. **Light safety.** No light flashes more than 3 times a second: an effect that would is slowed by itself, and the editor says "slowed to stay safe" beside the round's length. Fades never jump.

## 9. Triggering

1. **Tap** a song, a quick look or **Next ▸** on the iPad. A phone shows the same page as a remote (**Order**, **Groups**, **Looks**); it can't edit.
2. **Prepare and Go.** **Prepare** (top bar, turns violet) makes everything you do a draft; **Go ▸** sends it to the lights in one smooth change, and **Live** throws it away. See the service guide.
3. **Controller keys.** An APC mini works with no setup, in its standard layout. For any other key, use Settings › **Controller keys**: under **Running the service**, **Levels** and **Tempo**, press **Assign a key** next to an action and press the key within 10 seconds. **Clear** takes it off. **Reset to the APC mini layout** (tap twice) clears the APC mini's keys.
4. **A song's key.** Operator page › **Edit list**, then the small key button beside the song (it shows **＋**). Press a key on the controller. It only shows while a controller is plugged in.
5. **A quick look's key.** **Edit looks**, tap the quick look, then **Controller key**.
6. **Stream Deck and OSC** are set up as [companion.md](companion.md) says (OSC is switched on in Settings › OSC).

## 10. Check before Sunday

1. Switch Lightkey's output off, then **Send DMX** on in Settings.
2. On the operator page, turn **Prepare** on and tap through every song, watching the stage view; then **Live** and tap through them again with the lights in the room.
3. Look for anything that jumps, flickers or looks wrong. Hold **Flash** for each group to see that it moves the lights you expect; **Identify** in Patch finds a single light.
4. Press every controller key once.
5. Set the PIN, check **Who to call**, and **Export show file** again. Keep the file.
