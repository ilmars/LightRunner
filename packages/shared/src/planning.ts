// A service loaded from the online planning service: its items in order, each
// told apart by kind. Pure: the documents arrive already decoded to plain JSON,
// so nothing here touches the network.

import { z } from 'zod';

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
