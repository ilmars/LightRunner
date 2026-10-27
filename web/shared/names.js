// Suggested names for a new effect or quick look, made from its colours ("Purple chase", "Warm, purple and yellow").
// The operator page shows the suggestion in grey in the Name box: Save with the box empty keeps it, Tab fills it in.
// No DOM, so it can be tested.

/** A plain word for a colour picked freely (no name of its own): "blue", "warm white", "dim". */
export function colourWord(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  if (!m) return 'white';
  const [r, g, b] = m.slice(1).map((v) => parseInt(v, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max < 0.12) return 'dim';
  const sat = max ? (max - min) / max : 0;
  // Greys and pale tints read as white: warm, cool or plain.
  if (sat < 0.25 || (max > 0.85 && sat < 0.4)) return r > b + 0.06 ? 'warm white' : b > r + 0.06 ? 'cool white' : 'white';
  const d = max - min;
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  const words = [[15, 'red'], [40, 'orange'], [70, 'yellow'], [160, 'green'], [200, 'cyan'], [250, 'blue'], [290, 'purple'], [340, 'pink'], [360, 'red']];
  return words.find(([upTo]) => hue < upTo)[1];
}

/** A name further along a list starts small, unless it is written like a code ("UV", "3200K"). */
const inList = (name, k) => (k > 0 && /^[A-ZĀ-Ž][a-zā-ž]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name);

/** "A", "A and B", "A, B and C". */
export function listNames(names) {
  const list = names.map(inList);
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

/** Most-used first, then in the order given; each once. */
function byUse(names) {
  const count = new Map();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  return [...count.keys()].sort((a, b) => count.get(b) - count.get(a));
}

/** An effect's name: its colours (up to three, each once) and what it does ("Purple and blue wave"); `kind` as listed ("Wave"). */
export function effectSuggestion(colourNames, kind) {
  const colours = byUse(colourNames.filter(Boolean)).slice(0, 3);
  if (!colours.length) return kind;
  return `${listNames(colours)} ${kind.toLowerCase()}`;
}

/**
 * A quick look's name from what each of its groups shows (a colour or effect name; null for a group that adds no
 * colour, such as Off or a plain On): "All purple" when every group shows the same, else up to three, most-used first.
 */
export function lookSuggestion(labels) {
  const shown = labels.filter(Boolean);
  if (!shown.length) return '';
  const names = byUse(shown);
  if (names.length === 1 && shown.length > 1) return `All ${inList(names[0], 1)}`;
  return listNames(names.slice(0, 3));
}

/** `name`, or "name 2", "name 3" … when another already has it (the case doesn't count). */
export function uniqueName(name, taken) {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  if (!name || !used.has(name.toLowerCase())) return name;
  for (let k = 2; ; k++) if (!used.has(`${name} ${k}`.toLowerCase())) return `${name} ${k}`;
}
