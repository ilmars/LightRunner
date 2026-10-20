# Stream Deck, APC mini and OSC

How to run Light Runner from a Stream Deck (through Bitfocus Companion), an Akai APC mini, or another program that sends OSC. They all do the same things as the iPad (start a song, Next, Basic lights, Blackout, Undo, Flash, each group's colour and level, Master) and they all go through the same server, so the iPads and the devices always agree on what is on stage.

None of this has been tried on the real hardware yet. Each page below says what to look for when you try it.

Positions count from 1, the way you read them: "item 3" is the third item in the running order. Item 1 is always Basic lights, so item 2 is the first song and item 3 the second song. "group 2" is the second light group on the operator page (smoke machines are left out), "colour 4" is the fourth colour in that group's colour list (effects are not counted).

## Stream Deck through Companion

Light Runner talks to Companion over the network. You don't install a Light Runner plugin: you use Companion's own "Generic HTTP Requests" connection.

The names of menus change a little between Companion versions. The steps say what to look for rather than where exactly to click.

### 1. Add the connection

1. In Companion, open Connections and add **Generic HTTP Requests** (also listed as "Generic: HTTP Requests").
2. Set its **Base URL** to the Light Runner computer, for example `http://192.168.0.195:8080` (the church Mac; use `http://localhost:8080` if Companion runs on the same computer).
3. Leave authentication on None. Light Runner only answers computers on the local network.

With a Base URL set, the buttons below only need the path, like `/api/next`. If your version has no Base URL, put the whole address in each button.

### 2. Make a button

For every button, add an action from the connection and pick **POST**. Put the path in **URL**. Leave the body empty. The paths:

| Button | URL (POST) |
| --- | --- |
| Start item 3 (the second song) | `/api/item/3` |
| Start the first song (item 2) | `/api/item/2` |
| Next | `/api/next` |
| Back to (the item on stage) | `/api/back-to-look` |
| Basic lights (also item 1) | `/api/safe` |
| Blackout | `/api/blackout` |
| Undo | `/api/undo` |
| Flash group 2: on press | `/api/flash/2/on` |
| Flash group 2: on release | `/api/flash/2/off` |
| Flash all groups: on press | `/api/flash/all/on` |
| Flash all groups: on release | `/api/flash/all/off` |
| Group 2 to its colour 4 | `/api/group/2/colour/4` |
| Group 2 level to 50 % | `/api/group/2/level/50` |
| Master to 80 % | `/api/master/80` |
| Master up one step (10 %) | `/api/master/up` |
| Master down one step (10 %) | `/api/master/down` |

Notes:

- **Flash** needs two actions on one button: the "on" one under the button's **press** actions and the "off" one under its **release** actions. If a release is ever lost (a cable pulled, Companion restarted), Light Runner puts the Flash out by itself after 15 seconds.
- **Blackout** from a button happens at once, there is no hold. The iPad and the APC mini want a 1 second hold so it can't be hit by accident. On a Stream Deck, put the Blackout action under the button's **long press** (an action that only runs after the button has been held for a time; Companion calls this a press-and-hold group, with a hold time you set to 1000 ms). Blackout does not toggle: the lights come back when you start a song, Basic lights or Next.
- **Levels** are whole numbers from 0 to 100 (percent). Group and Master numbers outside that give an error.
- A button that has nothing behind it (item 9 when the list has 8 items, a colour the group doesn't have) answers with a plain-words error, such as "There is no song 9." (the message says "song" whichever item you asked for), and Companion shows the connection in an error colour until the next button that works. Nothing else happens.
- For Flash, the group can also be named by its id instead of its position. Positions are easier.

Light Runner answers `{"ok":true}` when it did what was asked.

### 3. Make buttons show what is on stage

Light Runner has one address that tells Companion the whole picture in one go:

`GET /api/companion`

It answers with something like this (shortened):

```json
{
  "look": "worship",
  "lookName": "Worship",
  "next": "sermon",
  "nextName": "Sermon",
  "changed": false,
  "blackout": false,
  "flashing": false,
  "master": 100,
  "tempo": 120,
  "groups": [
    { "n": 1, "name": "Front lights", "colour": "Warm", "level": 100 },
    { "n": 2, "name": "Key lights", "colour": "Blue", "level": 60 }
  ],
  "items": [
    { "n": 1, "name": "Basic lights", "onStage": false },
    { "n": 2, "name": "Worship", "onStage": true }
  ]
}
```

What the names mean:

| Name | Meaning |
| --- | --- |
| `lookName` | The name of what is on stage ("Blackout" while blacked out, empty before anything has run) |
| `nextName` | The name of what Next would start (empty at the end of the list) |
| `changed` | True when a group has been changed since the item started |
| `blackout` | True while blacked out |
| `flashing` | True while anything is flashing (not reported during Blackout) |
| `master` | Master, 0 to 100 |
| `tempo` | The stage tempo in beats per minute |
| `groups` | Each light group: its position `n`, `name`, running `colour` name ("Off" when it is dark) and `level` 0 to 100 |
| `items` | The running order: position `n`, `name`, and `onStage` (true for the one running) |

You can open `http://192.168.0.195:8080/api/companion` in a browser to see the real thing for your show.

The Generic HTTP connection doesn't poll by itself, so Companion needs a **trigger** that asks twice a second and keeps the answer in a **custom variable**:

1. **Custom variable.** In Companion's variables area open **Custom Variables** and add one called `lr`.
2. **Trigger.** Open Triggers and add one. Give it the event **Time interval** with 500 ms. Add this action from the Generic HTTP connection: **GET**, URL `/api/companion`. In its response options set **JSON Response Data Variable** to the custom variable `lr`, and turn **JSON Stringify Result** off (so the answer is kept as data, not as one long piece of text). Enable the trigger: new triggers start switched off.
3. **Check it.** The variable `$(custom:lr)` should now fill in. Companion's variables list shows its value.

Now use it in buttons. In button text, switch on the **expression** option for the text and write, for example:

| For | Expression |
| --- | --- |
| On stage | `$(custom:lr)['lookName']` |
| Next | `$(custom:lr)['nextName']` |
| Master | `$(custom:lr)['master']` |
| Group 2's colour name | `$(custom:lr)['groups'][1]['colour']` |
| Group 2's level | `$(custom:lr)['groups'][1]['level']` |

Lists count from 0 in expressions, so group 2 is `[1]`. Newer Companion versions (5.0 and later) also accept `$(custom:lr).lookName`; the bracket way works in the older ones too.

Colours for a button come from **feedbacks**: add Companion's feedback that checks an expression or a variable's value (its name differs a little between versions; look for "Check expression" or "Check variable value") and give it a background colour. Examples:

- **Blackout button red while blacked out:** the expression `$(custom:lr)['blackout']`, and a red background. Keep the red dark: nothing bright enough to light the operator's face.
- **The first song's button bright while it is on stage:** the expression `$(custom:lr)['items'][1]['onStage']` (item 2; `items[0]` is Basic lights).
- **Flash button lit while something flashes:** `$(custom:lr)['flashing']`.

If an expression gives an error in your Companion version, use Companion's `jsonpath` function instead: `jsonpath($(custom:lr), '$.lookName')`. Another way that works everywhere is one trigger action per value, "Custom Variable: Set with expression", which stores one small piece into its own variable (for example `lookName`) that buttons can show with plain `$(custom:lookName)`.

If Light Runner is not reachable, the variable keeps its last value and the connection shows an error. The Stream Deck still shows the last known picture, so check the iPad if the lights look wrong.

## APC mini

Plug the Akai APC mini into the computer that runs Light Runner (USB). Light Runner finds it within about 2 seconds, and finds it again if it is unplugged and plugged back in. Settings shows one of:

- "APC mini: connected (mk2)" or "(older model)": working.
- "APC mini: not connected": plug it in, or try another USB port or cable.
- "APC mini: MIDI support isn't installed on this computer": the optional MIDI add-on is missing. Run `npm install` in the Light Runner folder on that computer (on the church Mac, Node is Homebrew's keg-only copy, so use `/opt/homebrew/opt/node@24/bin/npm install`, or put `/opt/homebrew/opt/node@24/bin` on the PATH first). If the line still says it, note what the install printed and report it.

Each pad column sits above its fader, so one column is one light group (the operator page's order; smoke machines are left out).

| Part | Does |
| --- | --- |
| Faders 1 to 8 | Group levels (group 1 to 8) |
| Fader 9 | Master |
| Top two rows of pads (16) | The running order, from the top left: Basic lights, song 1, and so on. On stage: bright. Next: dimmer. Others: low |
| Lower six rows of pads | Colours. Column N is group N's first six colours (effects are not included), the first at the top. Tap to run one: the running colour is bright, the others dim |
| Buttons under the pads (8) | Flash group N while held |
| Buttons on the right, top to bottom | Next, Back to, Undo, Basic lights, Flash all (while held), Blackout (hold 1 second), two spare |

Things to know:

- **Faders pick up.** A fader only takes over once it reaches the level it controls (it passes it, or gets within 2 %). Until then moving it does nothing, so a light never jumps. After a song starts, every fader waits again until you move it to its new level. After someone changes a group's level on the iPad (or elsewhere), only that group's fader waits.
- **Blackout needs a 1 second hold**, the same as on the iPad, and it does not toggle. To get the lights back, start a song, Basic lights or Next.
- **The APC always works on the real stage.** Blind (a draft on one iPad) doesn't affect it.
- **If the APC is unplugged while a Flash button is held**, the Flash goes out. A Flash also goes out by itself after 15 seconds, so a button held down for a long time stops flashing.
- **The lights on the pads** always show the live stage, including changes made on any iPad.
- **mk2 and the older model** are told apart by the name the APC gives the computer. The mk2 shows each colour's real colour on its pads. The older model has only green, red and yellow lights: green is on stage or running, yellow is next (and the colours you can pick), dark is every other song.

### What to check when you try it

1. **Plug it in.** Within a few seconds Settings should say connected and name the model, and the pads should light up. On the mk2 the pads show colours: the top two rows follow the running order, the lower rows show the groups' colours. On the older model they show green and yellow.
2. **Faders pick up.** Move fader 1 slowly from the bottom: nothing should change until it gets to where group 1 already is; after that the group's level should follow the fader smoothly. Do the same with fader 9 (Master).
3. **Songs and colours.** Tap a pad in the top rows: that song should start and its pad turns bright. Tap a colour pad in a column: that group changes colour.
4. **Flash.** Hold a button under a column: that group flashes while it is held and goes out when you let go, or by itself after 15 seconds. Flash all is the fifth button on the right.
5. **Blackout.** Tap the sixth button on the right: nothing should happen. Hold it for a second: the stage goes dark. Tap Basic lights (the fourth button) to bring the lights back.
6. **Next, Back to and Undo** (the first three buttons on the right).
7. **Unplugging.** Hold a Flash button and unplug the APC: the Flash should go out. Then unplug it and plug it back in slowly (wait for Settings to say "not connected" first), and again unplug and plug it back in quickly (under 2 seconds). After each, check that the pads light up again (a quick replug can take up to 10 seconds to show them), and that pads, buttons and faders still work. Report what you saw each time.

What to report: a short note on each of the seven, plus the model and how it showed up in Settings. If the pads stay dark while Settings says connected, that is the useful one to report, and say which model it is. Two things have not been checked on real hardware: the older model's note numbers come from published community mappings (they may differ), and the mk2's colour message follows Akai's protocol document but has not been tried on a real mk2. The server's terminal also prints lines that start with "APC mini:" when something goes wrong (copy those into your report).

## OSC

OSC lets another program (ProPresenter, TouchOSC, a script) control the lights over the network. It is off until you switch it on: Settings > OSC > "Let other programs control the lights". The default port is 8000. Send to the Light Runner computer's address, UDP. Only computers on the local network are listened to, and nothing is sent back.

Every address starts with `/lightrunner`. Capital letters don't matter.

| Address | Does |
| --- | --- |
| `/lightrunner/item 3` | Start item 3 in the running order (a whole number; item 1 is Basic lights, item 2 the first song) |
| `/lightrunner/next` | Next |
| `/lightrunner/back` | Back to |
| `/lightrunner/undo` | Undo |
| `/lightrunner/basic` | Basic lights |
| `/lightrunner/blackout` | Blackout (at once, no hold) |
| `/lightrunner/group/2/level 0.5` | Group 2 to half |
| `/lightrunner/group/2/colour 4` | Group 2 to its colour 4 |
| `/lightrunner/flash/2 1` | Flash group 2 on (`0` puts it out) |
| `/lightrunner/flash/all 1` | Flash all groups on (`0` puts them out) |
| `/lightrunner/master 0.8` | Master to 80 % |
| `/lightrunner/master/up` | Master up one step (10 %) |
| `/lightrunner/master/down` | Master down one step (10 %) |

Good to know:

- **Levels** (group level and Master) take either a number from 0.0 to 1.0 (a float) or a whole number from 0 to 100 (percent). So `0.5` and `50` both mean half. A whole number `1` means 1 %, not full: send `1.0` or `100` for full. Many OSC apps send floats, which is what you want.
- **Buttons that send 1 on press and 0 on release** (TouchOSC and similar) work: for Next, Back, Undo, Basic lights, Blackout and Master up and down, a message with the value 0 (or False) is a release and does nothing, so one tap acts once. A message with no value acts too.
- **Flash** uses the value as on and off: anything above 0 (or True) is on, 0 (or False) is off. If the "off" message never arrives, Light Runner puts the Flash out by itself after 15 seconds.
- Messages that aren't understood (a wrong address, a group that isn't there) are ignored and noted in the server's terminal, once a minute for the same address.
- To check from a computer, any OSC tool that can send one message works (a phone or laptop app, or a short script).
