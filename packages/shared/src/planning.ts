// A service loaded from the online planning service: its items in order, each
// told apart by kind. Pure: the documents arrive already decoded to plain JSON,
// so nothing here touches the network.

import { z } from 'zod';
import type { Show } from './schema.ts';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'ids are lowercase letters, digits and dashes');

const MAX_NAME = 200;
const MIN_TEMPO = 40;
const MAX_TEMPO = 240;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const ItemKind = z.enum(['song', 'header', 'verse', 'slides', 'media', 'blank', 'other']);
export type ItemKind = z.infer<typeof ItemKind>;

export const ServiceItem = z.object({
  /** The planning service's cue id. */
  key: z.string().min(1).max(64),
  kind: ItemKind,
  name: z.string().max(MAX_NAME),
  songId: z.string().min(1).max(64).optional(),
  tempo: z.number().min(MIN_TEMPO).max(MAX_TEMPO).optional(),
  look: id.optional(),
});
export type ServiceItem = z.infer<typeof ServiceItem>;

export const PlannedService = z.object({
  id: z.string().min(1).max(64),
  /** The service type's name. */
  title: z.string().max(MAX_NAME),
  /** The first start time as the planning service writes it, e.g. 2026-10-25T08:00:00. */
  start: z.string().max(32),
  items: z.array(ServiceItem).max(500),
});
export type PlannedService = z.infer<typeof PlannedService>;

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clean = (v: string): string => v.trim().slice(0, MAX_NAME).trim();

/** A song item stores the song's id as its text: { cue_foreground: { type: 'text', text: id } }. */
function songIdOf(cue: Json): string | undefined {
  const fg = obj(cue.cue_foreground);
  const text = cue.cue_type !== 'g' && fg.type === 'text' ? str(fg.text) : '';
  return UUID.test(text) ? text : undefined;
}

/** What kind of item a planning-service cue is. */
export function itemKind(cue: unknown): ItemKind {
  const c = obj(cue);
  if (c.cue_type === 'g') return 'header';
  const fg = str(obj(c.cue_foreground).type);
  const bg = str(obj(c.cue_background).type);
  if (fg === 'bible') return 'verse';
  if (fg === 'slides') return 'slides';
  if (fg === 'text') return songIdOf(c) ? 'song' : str(obj(c.cue_foreground).text) === '' ? 'blank' : 'other';
  if (fg === '' && bg === '') return 'blank';
  if (fg === '' && bg === 'media') return 'media';
  return 'other';
}

/** The items of a service document (`doc` is the decoded document), the song library by id, and the service type's name. */
export function toPlannedService(idOfService: string, doc: unknown, songs: Map<string, unknown>, typeName: string): PlannedService {
  const d = obj(doc);
  const cues = obj(d.data).cues;
  const times = obj(d.service).times;
  const items = (Array.isArray(cues) ? cues : []).map((cueValue): ServiceItem => {
    const cue = obj(cueValue);
    const kind = itemKind(cue);
    const songId = kind === 'song' ? songIdOf(cue) : undefined;
    const song = songId ? obj(songs.get(songId)) : {};
    const display = str(cue.displayName);
    const cueName = str(cue.cue_name);
    const name =
      kind === 'song' ? display || cueName || str(song.name) : kind === 'header' ? cueName || display : display || cueName;
    const item: ServiceItem = { key: str(cue.cue_id), kind, name: clean(name) };
    if (songId) {
      item.songId = songId;
      const tempo = obj(song.data).tempo;
      if (typeof tempo === 'number' && tempo >= MIN_TEMPO && tempo <= MAX_TEMPO) item.tempo = tempo;
    }
    return item;
  });
  const start = str(obj(Array.isArray(times) ? times[0] : undefined).time);
  return PlannedService.parse({ id: idOfService, title: clean(typeName), start: start.slice(0, 32), items });
}

/** What to remember a look against, so it comes back next week; null for items that are never remembered. */
export function rememberKey(item: ServiceItem): string | null {
  switch (item.kind) {
    case 'song':
      return item.songId ? `song:${item.songId}` : null;
    case 'header':
      return `header:${item.name}`;
    case 'slides':
    case 'media':
    case 'other':
      return `item:${item.name}`;
    default:
      return null;
  }
}

// ---- The rows the running order shows ----
// planning.ts only imports the Show type (erased at run time), so it still loads before schema.ts.

/** One row of the running order as the operator page draws it. */
export type ServiceRow =
  /** A running-order look; `header` when its service item is a header. */
  | { kind: 'look'; look: string; header: boolean }
  /** A header that has no look in the order. */
  | { kind: 'header'; key: string; name: string }
  /** An item with no look in the order, or a repeated song (`look` set). */
  | { kind: 'item'; key: string; name: string; itemKind: ItemKind; look?: string }
  /** A run of one or more consecutive verses. */
  | { kind: 'verses'; keys: string[]; names: string[] };

/** The last row of the running order's top: Basic lights and the kept rows straight after it. */
function topOf(show: Show): string {
  const basic = show.operator.safeLook ?? show.operator.runningOrder[0] ?? '';
  const kept = new Set([basic, ...(show.operator.kept ?? [])]);
  let last = basic;
  for (const id of show.operator.runningOrder) {
    if (!kept.has(id)) break;
    last = id;
  }
  return last;
}

/**
 * Where each service item sits in the order. An item "owns" its look's row when it is the first item with a
 * look that is in the running order; every other item follows the nearest owner above it (when none, the last of
 * Basic lights and the kept rows at the top). A repeat of a song never owns, so what follows it stays with the
 * song's first place.
 */
function placeItems(show: Show): { owner: boolean[]; anchor: string[] } {
  const items = show.operator.service?.items ?? [];
  const order = new Set(show.operator.runningOrder);
  const owner: boolean[] = [];
  const anchor: string[] = [];
  let current = topOf(show);
  const seen = new Set<string>();
  for (const item of items) {
    anchor.push(current);
    const owns = item.look !== undefined && order.has(item.look) && !seen.has(item.look);
    owner.push(owns);
    if (owns) {
      seen.add(item.look!);
      current = item.look!;
    }
  }
  return { owner, anchor };
}

/**
 * The look id of the running-order row a service item (by its key) sits after: the nearest service item above
 * it whose look is in the running order, else the last of Basic lights and the kept rows at the top.
 */
export function anchorOf(show: Show, key: string): string {
  const at = (show.operator.service?.items ?? []).findIndex((i) => i.key === key);
  return at < 0 ? topOf(show) : placeItems(show).anchor[at]!;
}

/**
 * The running order as rows: every look once, in running-order order, and after each look the service items
 * that have no look of their own (headers, verses folded into runs, slides, a repeated song, ...), in service order.
 * Without a loaded service, one look row per running-order look.
 */
export function serviceRows(show: Show): ServiceRow[] {
  const order = show.operator.runningOrder;
  const items = show.operator.service?.items ?? [];
  const { owner, anchor } = placeItems(show);
  const ownerOf = new Map<string, ServiceItem>();
  items.forEach((item, n) => { if (owner[n]) ownerOf.set(item.look!, item); });

  const muted = new Map<string, ServiceRow[]>();
  const put = (at: string, row: ServiceRow) => muted.set(at, [...(muted.get(at) ?? []), row]);
  let verses: Extract<ServiceRow, { kind: 'verses' }> | undefined;
  items.forEach((item, n) => {
    if (owner[n]) {
      verses = undefined;
    } else if (item.kind === 'verse') {
      if (verses) {
        verses.keys.push(item.key);
        verses.names.push(item.name);
      } else {
        verses = { kind: 'verses', keys: [item.key], names: [item.name] };
        put(anchor[n]!, verses);
      }
    } else {
      verses = undefined;
      const inOrder = item.look !== undefined && order.includes(item.look);
      put(anchor[n]!, item.kind === 'header' && !inOrder
        ? { kind: 'header', key: item.key, name: item.name }
        : { kind: 'item', key: item.key, name: item.name, itemKind: item.kind, ...(inOrder ? { look: item.look } : {}) });
    }
  });

  const rows: ServiceRow[] = [];
  for (const look of order) {
    rows.push({ kind: 'look', look, header: ownerOf.get(look)?.kind === 'header' });
    rows.push(...(muted.get(look) ?? []));
    muted.delete(look);
  }
  // Nothing in the order to follow (a show without Basic lights): keep the items rather than lose them.
  for (const rest of muted.values()) rows.push(...rest);
  return rows;
}
