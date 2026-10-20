// MIDI ports on the server computer: the real ones through the optional @julusian/midi add-on, and a
// simulated set for tests. Light Runner runs without the add-on; it just can't use an APC mini then.

/** One open MIDI device: what goes out to it and what comes in from it. */
export interface MidiPort {
  send(bytes: number[]): void;
  onMessage(fn: (bytes: number[]) => void): void;
  close(): void;
}

export interface MidiPorts {
  /** The names of the MIDI inputs there are now. */
  list(): string[];
  /** Open the input with this name, and the output that goes with it. Throws when it can't. */
  open(name: string): MidiPort;
}

/** The part of @julusian/midi used here. */
interface MidiInput {
  getPortCount(): number;
  getPortName(port: number): string;
  openPort(port: number): void;
  closePort(): void;
  isPortOpen(): boolean;
  /** Frees the native port object; it can't be used after. */
  destroy(): void;
  ignoreTypes(sysex: boolean, timing: boolean, activeSensing: boolean): void;
  on(event: 'message', fn: (deltaTime: number, message: number[]) => void): void;
}
interface MidiOutput {
  getPortCount(): number;
  getPortName(port: number): string;
  openPort(port: number): void;
  closePort(): void;
  isPortOpen(): boolean;
  destroy(): void;
  sendMessage(message: number[]): void;
}
interface MidiModule {
  Input: new () => MidiInput;
  Output: new () => MidiOutput;
}

const ADDON = '@julusian/midi';

/**
 * The computer's MIDI ports, or null (and one line in the log) when the MIDI add-on isn't installed or
 * can't load. `load` stands in for importing the add-on in tests.
 */
export async function loadMidi(log: (msg: string) => void, load: () => Promise<unknown> = () => import(ADDON)): Promise<MidiPorts | null> {
  let mod: MidiModule;
  let lister: MidiInput;
  try {
    const m = (await load()) as Partial<MidiModule> & { default?: Partial<MidiModule> };
    mod = (m.Input ? m : m.default) as MidiModule;
    if (typeof mod?.Input !== 'function' || typeof mod.Output !== 'function') throw new Error('not the MIDI add-on');
    // The add-on loads its native part lazily; make it load now, so a broken one is found here.
    // This input is kept for listing: asking it again sees devices plugged in since (on a Mac it refreshes
    // CoreMIDI's list each time). A new one each time would print a warning on Windows when there are none.
    lister = new mod.Input();
    names(lister);
  } catch {
    log("APC mini: MIDI support isn't installed");
    return null;
  }
  return realPorts(mod, lister, log);
}

function names(port: MidiInput | MidiOutput): string[] {
  const out: string[] = [];
  for (let k = 0; k < port.getPortCount(); k++) out.push(port.getPortName(k));
  return out;
}

function realPorts(mod: MidiModule, lister: MidiInput, log: (msg: string) => void): MidiPorts {
  return {
    list: () => names(lister),
    open(name) {
      // The native port objects made here are destroyed again when opening fails and when the port closes.
      const input = new mod.Input();
      let output: MidiOutput | null = null;
      const free = () => {
        for (const p of [input, output]) {
          try {
            if (p?.isPortOpen()) p.closePort();
          } catch {
            // already gone
          }
          try {
            p?.destroy();
          } catch {
            // already gone
          }
        }
      };
      let handler: ((bytes: number[]) => void) | null = null;
      try {
        const at = names(input).indexOf(name);
        if (at < 0) throw new Error(`${name} is not there`);
        // SysEx in: the mk2's answer to its introduction says where the faders are.
        input.ignoreTypes(false, true, true);
        input.on('message', (_dt, message) => handler?.(message));
        input.openPort(at);
        // The output with the same name, or with the same device in its name (Windows: "MIDIOUT2 (...)").
        // If it can't be opened, the input is closed again: on Windows another try couldn't open it while held.
        output = new mod.Output();
        const outs = names(output);
        let to = outs.indexOf(name);
        if (to < 0) to = outs.findIndex((n) => n.includes(name) || name.includes(n));
        if (to >= 0) output.openPort(to);
        else log(`MIDI: no output found for "${name}", so its lights can't be set`);
      } catch (err) {
        free();
        throw err;
      }
      const out = output;
      let freed = false;
      return {
        send(bytes) {
          if (!freed && out.isPortOpen()) out.sendMessage(bytes);
        },
        onMessage(fn) {
          handler = fn;
        },
        close() {
          handler = null;
          if (freed) return;
          freed = true;
          free();
        },
      };
    },
  };
}

// ---- Simulated ports, for tests ----

export class FakeMidiPort implements MidiPort {
  readonly name: string;
  /** Every message sent to the device, in order. */
  readonly sent: number[][] = [];
  closed = false;
  private handler: ((bytes: number[]) => void) | null = null;

  constructor(name: string) {
    this.name = name;
  }

  send(bytes: number[]): void {
    if (this.closed) throw new Error('port closed');
    this.sent.push([...bytes]);
  }

  onMessage(fn: (bytes: number[]) => void): void {
    this.handler = fn;
  }

  close(): void {
    this.closed = true;
    this.handler = null;
  }

  /** The device sends this. */
  receive(bytes: number[]): void {
    this.handler?.([...bytes]);
  }
}

export class FakeMidi implements MidiPorts {
  private readonly names: string[] = [];
  /** Every port opened, in order. */
  readonly opened: FakeMidiPort[] = [];
  /** Opening throws while this is set (a device another program holds). */
  failOpen = false;

  /** The port open now, if any. */
  get port(): FakeMidiPort | undefined {
    const last = this.opened.at(-1);
    return last && !last.closed ? last : undefined;
  }

  plug(name: string): void {
    this.names.push(name);
  }

  unplug(name: string): void {
    const k = this.names.indexOf(name);
    if (k >= 0) this.names.splice(k, 1);
  }

  list(): string[] {
    return [...this.names];
  }

  open(name: string): FakeMidiPort {
    if (this.failOpen) throw new Error('the port is in use');
    if (!this.names.includes(name)) throw new Error(`${name} is not there`);
    const port = new FakeMidiPort(name);
    this.opened.push(port);
    return port;
  }
}
