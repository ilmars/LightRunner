#!/usr/bin/env python3
"""Turn a Lightkey project (.lightkeyproj) into a Light Runner show.

Reads the DMX patch, each fixture mode's channel layout, the stage plan
positions and simple single-colour presets. Makes one group per fixture
model, a preset per colour for every group, and a few starter looks.

    python3 tools/import-lightkey.py PROJECT.lightkeyproj OUT.json \
        --artnet-host 192.168.0.114 --universe 1

Only the Python standard library is needed (Lightkey projects are Apple
keyed-archive property lists, which plistlib reads).
"""

import argparse
import json
import plistlib
import re
import unicodedata
import uuid

# ---- Reading the keyed archive ----


def unarchive(data):
    """Resolve an NSKeyedArchiver plist into plain dicts and lists."""
    archive = plistlib.loads(data) if isinstance(data, bytes) else data
    objs = archive['$objects']

    def classname(o):
        if isinstance(o, dict) and isinstance(o.get('$class'), plistlib.UID):
            return objs[o['$class'].data].get('$classname')
        return None

    def res(x, seen=()):
        if isinstance(x, plistlib.UID):
            if x.data in seen:
                return None
            return res(objs[x.data], seen + (x.data,))
        if isinstance(x, dict):
            c = classname(x)
            if c in ('NSArray', 'NSMutableArray', 'NSSet', 'NSMutableSet', 'NSOrderedSet', 'NSMutableOrderedSet'):
                return [res(v, seen) for v in x['NS.objects']]
            if c in ('NSDictionary', 'NSMutableDictionary'):
                return {str(res(k, seen)): res(v, seen) for k, v in zip(x['NS.keys'], x['NS.objects'])}
            if c in ('NSString', 'NSMutableString'):
                return x['NS.string']
            if c == 'NSUUID':
                return str(uuid.UUID(bytes=bytes(x['NS.uuidbytes']))).upper()
            out = {'$class': c} if c else {}
            for k, v in x.items():
                if k != '$class':
                    out[k] = res(v, seen)
            return out
        if isinstance(x, list):
            return [res(v, seen) for v in x]
        if isinstance(x, bytes) and x[:6] == b'bplist':
            try:
                inner = plistlib.loads(x)
            except Exception:
                return None
            return unarchive(inner) if isinstance(inner, dict) and '$objects' in inner else inner
        if x == '$null':
            return None
        return x

    return {k: res(v) for k, v in archive['$top'].items()}


# ---- Helpers ----


def slug(text):
    t = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode()
    t = re.sub(r'[^a-zA-Z0-9]+', '-', t).strip('-').lower()
    return t or 'x'


def byte(v):
    return v & 255 if isinstance(v, int) else 0


def ranges(cap):
    """[(start, end, params)] of a capability's DMX ranges."""
    out = []
    for s in cap.get('settings') or []:
        r = s.get('$0') or {}
        out.append((byte(r.get('$0', 0)), byte(r.get('$1', 255)), s.get('params') or {}))
    return out


def point(text):
    """'{x, y}' -> (x, y)."""
    a, b = re.findall(r'-?[\d.]+(?:e-?\d+)?', text or '{0, 0}')[:2]
    return float(a), float(b)


def colour16(c):
    """Lightkey packs plain colours as 16-bit R, G, B in one integer, each an
    8-bit value repeated (0xffff, 0x5a5a). Anything else (gels, colour
    temperatures) uses another encoding and returns None."""
    comps = [(c >> 32) & 0xFFFF, (c >> 16) & 0xFFFF, c & 0xFFFF]
    if c >> 48 or any((v >> 8) != (v & 255) for v in comps):
        return None
    return '#%02x%02x%02x' % tuple(v >> 8 for v in comps)


COMPONENT_ROLES = {
    'Red': 'red', 'Green': 'green', 'Blue': 'blue',
    'White': 'white', 'CoolWhite': 'white', 'WarmWhite': 'white', 'NeutralWhite': 'white',
    'Amber': 'amber', 'Ultraviolet': 'uv',
}


def channel_for(cap):
    kind = (cap.get('$class') or '').replace('LX', '').replace('Capability', '')
    rs = ranges(cap)
    if kind == 'Intensity':
        return {'role': 'dimmer'}
    if kind == 'ColorComponent':
        name = (rs[0][2].get('componentName') if rs else None) or ''
        role = COMPONENT_ROLES.get(name)
        return {'role': role, 'name': name} if role else {'role': 'other', 'default': 0, 'name': name}
    if kind == 'ColorFilter' and rs and 'minTemperature' in rs[0][2]:
        p = rs[0][2]
        return {'role': 'cct', 'kelvin': {'min': p['minTemperature'], 'max': p['maxTemperature']}}
    if kind == 'ShutterStrobe':
        # Lightkey shutter modes: 0 closed, 1 open, 2+ strobe/pulse. Park on "open".
        open_ = next((r for r in rs if r[2].get('mode') == 1), None)
        return {'role': 'strobe', 'default': open_[0] if open_ else 0}
    if kind == 'Custom':
        off = next((r for r in rs if str(r[2].get('name', '')).lower() == 'off'), None)
        first = rs[0] if rs else (0, 0, {})
        return {'role': 'other', 'default': (off or first)[0], 'name': (first[2].get('name') or 'custom')}
    return {'role': 'other', 'default': 0, 'name': kind}


# ---- Conversion ----


def convert(top, host, universe, named_groups=(), skip=()):
    profiles_by_uuid = {p['UUID']: p for p in top['fixtureProfiles']}
    lk_fixtures = [f for u in top['universes'] for f in u['fixtures'] if slug(f['shortName']) not in skip]

    # Profiles: one per fixture model + mode actually used.
    profiles, profile_ids = [], {}
    for f in lk_fixtures:
        key = (f['fixtureProfileUUID'], f['personalityIndex'])
        if key in profile_ids:
            continue
        lp = profiles_by_uuid[key[0]]
        per = lp['personalities'][key[1]]
        caps = {c['channel']: c for c in per['capabilities'] if isinstance(c.get('channel'), int)}
        channels = [channel_for(caps[n]) if n in caps else {'role': 'other', 'default': 0}
                    for n in range(per['footprint'])]
        mode = per.get('customName') or f'{per["footprint"]} ch'
        pid = slug(f'{lp["manufacturer"]}-{lp["name"]}-{mode}')
        profile_ids[key] = pid
        profiles.append({'id': pid, 'name': f'{lp["manufacturer"]} {lp["name"]} ({mode})', 'channels': channels})

    # Stage positions, normalised to 0..1 with the back of the stage at the top.
    positions = {}
    for stage in top.get('stages') or []:
        for item in stage.get('items') or []:
            if item.get('$class') == 'LXFixtureStageItem' and item.get('fixture'):
                w, h = point(item.get('unrotatedSize'))
                if abs(abs(float(item.get('angle') or 0)) - 90) < 1:
                    w, h = h, w
                positions[item['fixture']['UUID']] = point(item.get('center')) + (w, h)
    xs = [v for p in positions.values() for v in (p[0] - p[2] / 2, p[0] + p[2] / 2)] or [0, 1]
    ys = [v for p in positions.values() for v in (p[1] - p[3] / 2, p[1] + p[3] / 2)] or [0, 1]
    pad_x, pad_y = (max(xs) - min(xs)) * 0.03 + 1, (max(ys) - min(ys)) * 0.06 + 1
    x0, x1, y0, y1 = min(xs) - pad_x, max(xs) + pad_x, min(ys) - pad_y, max(ys) + pad_y

    fixtures, fixture_id = [], {}
    for f in lk_fixtures:
        lp = profiles_by_uuid[f['fixtureProfileUUID']]
        fid = slug(f['shortName'])
        fixture_id[f['UUID']] = fid
        px, py, pw, ph = positions.get(f['UUID'], ((x0 + x1) / 2, (y0 + y1) / 2, 0, 0))
        fixtures.append({
            'id': fid,
            'name': f'{f["shortName"]} {lp["name"]}',
            'profile': profile_ids[(f['fixtureProfileUUID'], f['personalityIndex'])],
            'universe': universe,
            'address': f['address'] + 1,
            'x': round((px - x0) / (x1 - x0), 3),
            # Lightkey's stage y grows towards the back; ours grows towards the audience.
            'y': round(1 - (py - y0) / (y1 - y0), 3),
            **({'w': round(min(1, pw / (x1 - x0)), 3), 'h': round(min(1, ph / (y1 - y0)), 3)} if pw > 12 or ph > 12 else {}),
        })

    # Lightkey single-colour presets: {fixture uuids} -> [(name, hex, intensity)].
    imported = []

    def walk(node, folder):
        if node.get('$class') == 'LXPreset':
            store = node.get('fpStore') or {}
            containers = store.get('umbrellaContainers') or {}
            colours = set()
            for c in containers.values():
                for seg in c.get('segmentContainers') or []:
                    if seg.get('color'):
                        colours.add((colour16(seg['color'][0]), float(seg.get('intensity', 1))))
            if any(c[0] is None for c in colours):
                print(f'Skipping preset "{node["name"]}": not a plain RGB colour')
            elif containers and len(colours) == 1:
                hex_, level = colours.pop()
                imported.append((folder, node['name'], frozenset(k.upper() for k in containers), hex_, level))
        for child in node.get('childNodes') or []:
            walk(child, node.get('name'))

    walk(top['rootPresetGroup'], None)

    # Groups: the ones named on the command line, then one per fixture model
    # for whatever is left. Fixtures run left to right on the stage.
    groups = []
    by_short = {slug(f['shortName']): f for f in lk_fixtures}
    taken = set()
    for name, ids in named_groups:
        members = [by_short[i] for i in ids if i in by_short]
        missing = [i for i in ids if i not in by_short]
        if missing:
            raise SystemExit(f'Group "{name}": no fixture called {", ".join(missing)}')
        members.sort(key=lambda f: positions.get(f['UUID'], (0, 0))[0])
        taken.update(f['UUID'] for f in members)
        groups.append({'id': slug(name), 'name': name, 'fixtures': [fixture_id[f['UUID']] for f in members],
                       '_uuids': frozenset(f['UUID'].upper() for f in members), '_profile': None})
    by_model = {}
    for f in lk_fixtures:
        if f['UUID'] not in taken:
            by_model.setdefault(f['fixtureProfileUUID'], []).append(f)
    for puuid, members in by_model.items():
        lp = profiles_by_uuid[puuid]
        members.sort(key=lambda f: positions.get(f['UUID'], (0, 0))[0])
        uuids = frozenset(f['UUID'].upper() for f in members)
        # Name it after a Lightkey preset folder that targets exactly these fixtures.
        folder = next((p[0] for p in imported if p[2] == uuids and p[0] and p[0] != 'Root Preset Group'), None)
        name = folder or (f'{lp["name"]} {members[0]["shortName"]}' if len(members) == 1 else lp['name'])
        groups.append({'id': slug(name), 'name': name, 'fixtures': [fixture_id[f['UUID']] for f in members],
                       '_uuids': uuids, '_profile': lp})

    # The colour palette: every colour from the imported presets, named as in Lightkey.
    def clean(name, folder):
        n = name
        if folder and folder != 'Root Preset Group':
            prefix = folder.split()[0]
            if n.upper().startswith(prefix.upper() + ' '):
                n = n[len(prefix) + 1:]
        return n[:1].upper() + n[1:].lower() if n.isupper() else n

    palette_colours, palette_names = [], []
    for folder, name, _, hex_, level in imported:
        if level <= 0 or hex_ in [c['hex'] for c in palette_colours]:
            continue
        palette_colours.append({'hex': hex_})
        palette_names.append(clean(name, folder))
    off_name = next((clean(n, fo) for fo, n, _, _, lv in imported if lv <= 0), 'Off')

    presets = []
    for g in groups:
        roles = {c['role'] for p in profiles for c in p['channels'] if p['id'] in
                 {fx['profile'] for fx in fixtures if fx['id'] in g['fixtures']}}
        has_rgb = {'red', 'green', 'blue'} <= roles
        if has_rgb:
            for k, (c, name) in enumerate(zip(palette_colours, palette_names)):
                presets.append({'id': f'{g["id"]}-{slug(name)}', 'name': name, 'group': g['id'], 'fade': 3,
                                'swatch': c['hex'], 'layers': [{'kind': 'static', 'colour': {'palette': 'lightkey', 'index': k}, 'intensity': 1}]})
        elif 'cct' in roles:
            for name, hex_, level in [('Silti 3200K', '#ffb46b', 1), ('Neitrāli 5600K', '#ffeedd', 1),
                                      ('Vēsi 6500K', '#fffaf6', 1), ('Silti 50%', '#ffb46b', 0.5)]:
                presets.append({'id': f'{g["id"]}-{slug(name)}', 'name': name, 'group': g['id'], 'fade': 3,
                                'swatch': hex_, 'layers': [{'kind': 'static', 'colour': {'hex': hex_}, 'intensity': level}]})
        else:
            for name, level in [('100%', 1), ('50%', 0.5)]:
                presets.append({'id': f'{g["id"]}-{slug(name)}', 'name': name, 'group': g['id'], 'fade': 3,
                                'swatch': '#ffd9b0', 'layers': [{'kind': 'static', 'colour': {'hex': '#ffffff'}, 'intensity': level}]})
        presets.append({'id': f'{g["id"]}-off', 'name': off_name, 'group': g['id'], 'fade': 3, 'swatch': '#000000',
                        'layers': [{'kind': 'static', 'colour': {'hex': '#ffffff'}, 'intensity': 0}]})
        g['_kind'] = 'rgb' if has_rgb else 'cct' if 'cct' in roles else 'dim'

    preset_ids = {p['id'] for p in presets}

    def pick(g, *names):
        for n in names:
            pid = f'{g["id"]}-off' if n == off_name else f'{g["id"]}-{slug(n)}'
            if pid in preset_ids:
                return pid
        return None

    # Starter looks: key lights (CCT) and colour fixtures each get a matching preset.
    # Columns: white-only (CCT) groups, key light groups (kept white), colour groups.
    starter = [
        ('walk-in', 'Walk-in', 'Before', ('Silti 50%',), (off_name,), ('Zils', 'Blue')),
        ('worship', 'Worship', 'Worship', ('Silti 3200K',), ('Silti balts', 'Warm white'), ('Violets', 'Violet')),
        ('sermon', 'Sermon', 'Word', ('Neitrāli 5600K',), ('Vēsi balts', 'Cool white'), ('Zils', 'Blue')),
        ('response', 'Response', 'Response', ('Silti 3200K',), ('Silti balts', 'Warm white'), ('Oranžs', 'Orange')),
        ('prayer', 'Prayer', 'Response', ('Silti 50%',), (off_name,), ('Zils', 'Blue')),
        ('all-white', 'All white', 'Utility', ('Neitrāli 5600K',), ('Vēsi balts', 'Cool white'), ('Vēsi balts', 'Cool white')),
    ]
    looks = []
    for lid, name, section, cct_names, key_names, rgb_names in starter:
        entries = []
        for g in groups:
            is_key = re.search(r'key|atslēg', g['name'], re.I) is not None
            names = cct_names if g['_kind'] == 'cct' else (key_names if is_key else rgb_names) if g['_kind'] == 'rgb' else ('100%',)
            pid = pick(g, *names)
            if pid:
                entries.append({'group': g['id'], 'preset': pid})
        swatch = next((p['swatch'] for p in presets if entries and p['id'] == entries[-1]['preset']), None)
        looks.append({'id': lid, 'name': name, 'section': section, 'swatch': swatch, 'groups': entries})

    for g in groups:
        for k in ('_uuids', '_profile', '_kind'):
            g.pop(k, None)

    return {
        'schemaVersion': 1,
        'name': 'Dieva Mājas skatuve (from Lightkey)',
        'profiles': profiles,
        'fixtures': fixtures,
        'groups': groups,
        'palettes': [{'id': 'lightkey', 'name': 'Lightkey colours', 'colours': palette_colours}] if palette_colours else [],
        'presets': presets,
        'looks': looks,
        'operator': {'looks': [l['id'] for l in looks], 'groups': [g['id'] for g in groups], 'manualForOperators': False},
        'settings': {'output': {'kind': 'artnet', 'host': host}, 'frameRate': 40, 'gamma': 2.2},
        'stage': {'grid': 10},
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('project')
    ap.add_argument('out')
    ap.add_argument('--artnet-host', default='255.255.255.255', help='Art-Net node IP (default: broadcast)')
    ap.add_argument('--universe', type=int, default=0, help='Art-Net universe (port-address) the node listens on')
    ap.add_argument('--name', help='show name')
    ap.add_argument('--group', action='append', default=[], metavar='"NAME=ID,ID"',
                    help='a group of fixtures by short name, e.g. "Front lights=p1,p2,p3,p4" (repeatable)')
    ap.add_argument('--skip', action='append', default=[], metavar='ID', help='leave a fixture out, e.g. p5 (repeatable)')
    args = ap.parse_args()
    named = []
    for g in args.group:
        name, _, ids = g.partition('=')
        named.append((name.strip(), [slug(i) for i in ids.split(',') if i.strip()]))
    with open(args.project, 'rb') as fh:
        top = unarchive(fh.read())
    show = convert(top, args.artnet_host, args.universe, named, {slug(x) for x in args.skip})
    if args.name:
        show['name'] = args.name
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(show, fh, indent=2, ensure_ascii=False)
    print(f'{len(show["fixtures"])} fixtures, {len(show["profiles"])} profiles, {len(show["groups"])} groups, '
          f'{len(show["presets"])} presets, {len(show["looks"])} looks -> {args.out}')


if __name__ == '__main__':
    main()
