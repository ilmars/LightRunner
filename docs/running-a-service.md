# Running the lights: setup and a service

A plain guide for the lighting lead and volunteers at stage L1. Part 1 is setting things up (once, and again after anything changes). Part 2 is a service, from arriving to going home. The controllers are in more detail in [companion.md](companion.md).

**The rig in one line:** the Light Runner computer (the church Mac, 192.168.0.195) sends to the Art-Net node "NetWork Node 2" (192.168.0.114, universe 1), which drives the lights. iPads and phones open Light Runner's page over the church Wi-Fi. Lightkey and Light Runner must never send to the node at the same time.

## Part 1. Setting up

### The Light Runner computer

1. **Install Light Runner.** Download it and install it as the [README's Install section](../README.md#install) says (the first time you open it, the Mac asks once: right-click it, then Open). No Terminal and no Node are needed.

2. **It starts with the computer.** Light Runner starts by itself when the computer starts and sits in the menu bar (the Mac) or the system tray (Windows). Open it to see the window: it says **Running**, and **Add an iPad or phone** shows the address for the iPads. Closing the window doesn't stop it. If the window says something is wrong, its **Fix it** button takes you to the fix.

   Away from the church (testing at home), turn on **Options › Test mode: don't send to the lights**, so it never sends to any lights. Turn it off again at the church.

   *From source:* if Light Runner is run from the `LightRunner` folder instead of installed, start it in Terminal there with `/opt/homebrew/opt/node@24/bin/node server/src/main.ts` (after `/opt/homebrew/opt/node@24/bin/npm install` the first time and after an update), and leave that Terminal window open: closing it stops the lights. Use `LIGHT_RUNNER_OUTPUT=none` in front instead of Test mode. It doesn't start by itself.

3. **Keep the computer awake**: in System Settings, set the display and computer not to sleep while it is plugged in.

### Lightkey and Light Runner

Only one of them may send to the node.

- **Light Runner takes the lights:** quit Lightkey (or switch its output off), then Light Runner › Settings › DMX output › **Send DMX** on.
- **Lightkey takes them back:** Light Runner › Settings › **Send DMX** off first, then start Lightkey's output.

If both send, the operator page shows "Another desk is sending" in amber.

### Settings (the programmer)

Open `http://192.168.0.195:8080/settings/` (or `http://localhost:8080/settings/` on the Mac itself).

- **Programmer PIN**: set one (4 to 6 digits) so volunteers can't change the patch or settings by accident. Keep it written down somewhere safe, not on the iPad.
- **Who to call**: a name and a phone number. Volunteers see them when the lights have a problem.
- **Operators may use manual control**: on if volunteers should be able to set single lights (Individual lights on the operator page).
- **Backups**: Light Runner keeps the last 20 saves by itself. Before big changes, also use **Export show file** and keep the file.
- **Controller keys**: see below.

### The iPads

1. Join the church Wi-Fi (the same network as the Mac).
2. In Safari open `http://192.168.0.195:8080/operator/`.
3. Share › **Add to Home Screen**. It gets the Light Runner icon; open it from there from now on.
4. Settings › Display & Brightness › **Auto-Lock: Never**, and turn the brightness down for the dark room.
5. A phone works too: the same address gives the phone remote (Order, Groups, Looks).

### Controllers (optional)

- **APC mini**: plug it into the Mac by USB. Within a few seconds Settings › Controller keys › Devices says it is connected. It works straight away with its standard layout: faders are the groups and Master, the top pad rows are the running order, the lower pads are colours, the buttons under the pads are Flash, and the side buttons are Next, Back to, Undo, Basic lights, Flash all and Blackout (hold 1 second).
- **Your own keys**: in Settings › Controller keys tap **Assign a key** next to an action and press the key within 10 seconds. A song's key is set in running-order **Edit list** (the Key chip), a quick look's in its **Edit** sheet.
- **Stream Deck (Companion)** and **OSC**: see [companion.md](companion.md).

### The show

Songs, colours, quick looks and effects are made on the operator page; the fixtures and groups on the Patch page. Before a service, check that every song in the running order looks right (Prepare is good for this, see below).

## Part 2. A service

### Before people arrive (15 minutes)

1. Open Light Runner on the Mac if it isn't running (its icon is in the menu bar; if not, open Light Runner from Applications). Its window should say **Running**. Lightkey off, **Send DMX on**.
2. Open the operator page on the iPad. The top bar should show **On stage** and a name, and **no amber pill**. If there is one, see "When something is wrong" below.
3. Tap **Basic lights**: the stage should come up warm. Then tap through the songs once with the stage in view. Every change fades; nothing should jump.
4. If you use the APC mini: plug it in, check its pads light up, and press Next once.

### During the service

- **Start a song**: tap it in the running order, or **Next ▸** in the bottom bar (it shows the name of the next one).
- **A group's colour**: tap the group's colour button in Groups and pick a colour. **Dim a group**: drag its slider. **Master** dims everything.
- **Quick looks**: one tap changes just their groups (for example "Prayer").
- **Flash**: hold a Flash button; it goes out when you let go.
- **Something looks wrong**: **Undo** takes back the last change, **Back to saved** brings the song back as saved, and **Safe · Basic lights** always brings back a warm stage.
- **Blackout**: hold for 1 second. A song, Basic lights or Next brings the lights back.
- **Preparing the next moment without touching the lights**: tap **Prepare** in the top bar (it turns violet). Now taps only change a draft, shown in the stage view. **Go ▸** sends the draft to the lights in one smooth change; **Live** throws it away. **Save to <song>** (hold) keeps the draft in that song.
- **Tempo** for effects: tap **Tap** in time with the music, or type the number in the Tempo menu.

### When something is wrong

| You see | What it means | What to do |
| --- | --- | --- |
| Amber **Not sending to the lights** | Send DMX is off | Settings › Send DMX on (make sure Lightkey isn't sending) |
| Amber **Lights not answering** | The node doesn't answer | Check the node's power and network cable. Tap the pill for details and Who to call |
| Amber **Another desk is sending** | Lightkey or another desk is sending too | Stop the other desk's output |
| A red banner **Connection lost. Lights keep running. Reconnecting…** | The iPad can't reach the Mac (the lights keep their last look) | Check the iPad's Wi-Fi, and that Light Runner is running on the Mac (its icon is in the menu bar; open it and look for **Running**). It reconnects by itself |
| A light flickers or jumps | Not normal | Tap Basic lights, then tell the lighting lead what you did just before |

If nothing helps, call the person in **Who to call** (the problem pill shows them).

### After the service

1. Tap **Basic lights** or **Blackout** as the room needs.
2. If Lightkey is used next: Settings › **Send DMX off** before starting Lightkey.
3. Changes made during the service are saved by themselves. If you made many, the lighting lead can **Export show file** in Settings as an extra copy.
4. Leave Light Runner running; it is meant to. To stop it, choose **Quit Light Runner** from its menu-bar icon (it asks first: the lights stop following the iPads). If it is run from source, stop it with Ctrl+C in its Terminal window.
