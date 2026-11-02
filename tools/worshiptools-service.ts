// Print the order of service (headers, songs, items) of a WorshipTools Planning service.
//
//   node tools/worshiptools-service.ts --login            # once: paste the weAuthRefresh cookie
//   node tools/worshiptools-service.ts SERVICE_URL [--json]
//
// The service is a Firestore document, accounts/{account}/cuelists/{service}, with
// its items in data.cues; api.worship.tools hands out the Firebase login for it.
// Login and the WorshipTools calls are explained in tools/worshiptools.ts.

import { parseArgs } from 'node:util';
import { apiClient, getJson, saveLogin } from './worshiptools.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    login: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

type Item = {
  id: string;
  kind: 'header' | 'song' | 'item';
  title: string;
  key?: string;
  notes?: string;
  lengthSeconds?: number;
  songId?: string;
  artist?: string;
  tempo?: number;
  timeSignature?: string;
};

try {
  if (values.login) {
    await saveLogin();
  } else {
    const ids = /\/account\/([0-9a-f-]{36})\/service\/([0-9a-f-]{36})/.exec(positionals[0] ?? '');
    if (!ids) {
      console.error('Usage: node tools/worshiptools-service.ts SERVICE_URL [--json]');
      console.error('       node tools/worshiptools-service.ts --login');
      process.exit(2);
    }
    const service = await getService(ids[1], ids[2]);
    if (values.json) console.log(JSON.stringify(service, null, 2));
    else printService(service);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

async function getService(accountId: string, serviceId: string) {
  const api = apiClient();
  const [firebase, { token: customToken }, serviceTypes] = await Promise.all([
    api('/config/firebase'),
    api('/firebase/token'),
    api(`/account/${accountId}/meta/service-types`),
  ]);
  const { idToken } = await getJson(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebase.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const database = `projects/${firebase.projectId}/databases/(default)`;
  const firestore = `https://firestore.googleapis.com/v1/${database}/documents`;
  const auth = { Authorization: `Bearer ${idToken}` };

  const doc = fromFirestore(await getJson(`${firestore}/accounts/${accountId}/cuelists/${serviceId}`, { headers: auth }));
  const cues: any[] = doc.data?.cues ?? [];
  const songMeta: Record<string, { key?: string; notes?: string }> = doc.data?.songMeta ?? {};

  // Song items only hold the song's id; fetch all the songs in one request.
  const songIds = [...new Set(cues.map(songIdOf).filter((id): id is string => !!id))];
  const songs = new Map<string, any>();
  if (songIds.length) {
    const found: any[] = await getJson(`${firestore}:batchGet`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents: songIds.map((id) => `${database}/documents/accounts/${accountId}/songs/${id}`) }),
    });
    for (const r of found) if (r.found) songs.set(r.found.name.split('/').pop(), fromFirestore(r.found));
  }

  const items: Item[] = cues.map((cue) => {
    const meta = songMeta[cue.cue_id] ?? {};
    const songId = songIdOf(cue);
    const song = songId ? songs.get(songId) : undefined;
    const item: Item = {
      id: cue.cue_id,
      kind: cue.cue_type === 'g' ? 'header' : songId ? 'song' : 'item',
      title: cue.displayName || cue.cue_name || song?.name || '',
      key: meta.key || song?.data?.defaultKey || undefined,
      notes: meta.notes || undefined,
      lengthSeconds: cue.length || undefined,
    };
    if (songId) {
      item.songId = songId;
      item.artist = song?.data?.text_artist || undefined;
      item.tempo = song?.data?.tempo || undefined;
      item.timeSignature = song?.data?.timeSignature || undefined;
    }
    return item;
  });

  return {
    id: serviceId,
    type: serviceTypes.find((t: any) => t.id === doc.service?.type)?.name ?? '',
    title: doc.name || doc.data?.cuelist_title || '',
    times: (doc.service?.times ?? []).map((t: any) => t.time),
    notes: doc.service?.notes || '',
    lastEditedBy: doc.user?.name ?? '',
    items,
  };
}

/** A song item stores the song's id as its text: { cue_foreground: { type: 'text', text: id } }. */
function songIdOf(cue: any): string | undefined {
  const text = cue.cue_type !== 'g' && cue.cue_foreground?.type === 'text' ? cue.cue_foreground.text : '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text) ? text : undefined;
}

/** Turn a Firestore REST document ({ fields: { x: { stringValue } } }) into plain JSON. */
function fromFirestore(doc: any): any {
  const value = (v: any): any => {
    if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, value(x)]));
    if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(value);
    if ('integerValue' in v) return Number(v.integerValue);
    if ('nullValue' in v) return null;
    return Object.values(v)[0]; // string, double, boolean, timestamp, reference
  };
  return value({ mapValue: { fields: doc.fields } });
}

function printService(s: Awaited<ReturnType<typeof getService>>): void {
  console.log([s.type, s.title].filter(Boolean).join(' - '));
  for (const t of s.times) console.log(t.replace('T', ' '));
  if (s.notes) console.log(s.notes);
  console.log();
  for (const item of s.items) {
    if (item.kind === 'header') {
      console.log(`== ${item.title}`);
      continue;
    }
    const extra = [
      item.key && `key ${item.key}`,
      item.tempo && `${item.tempo} bpm`,
      item.timeSignature,
      item.lengthSeconds && `${Math.floor(item.lengthSeconds / 60)}:${String(item.lengthSeconds % 60).padStart(2, '0')}`,
    ].filter(Boolean);
    console.log(`   ${item.title}${extra.length ? `  (${extra.join(', ')})` : ''}`);
    if (item.notes) console.log(`      ${item.notes}`);
  }
}
