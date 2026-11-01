// When a Patch save is refused because the show changed somewhere else since the page loaded it (an import, an edit
// on the iPad), the page loads the show again and does its own unsaved changes again on top. Patch owns the fixture
// types, the fixtures (with their places on the stage plan) and the groups; everything else comes from the new show,
// apart from what deleting or adding a group does to it here.

/**
 * `fresh` with what this page changed between `base` (the show as it loaded it) and `mine` (its working copy).
 * A type, fixture or group this page changed or added is taken whole; one it deleted goes; one it left alone is
 * the new show's.
 */
export function rebasePatch(base, mine, fresh) {
  const out = structuredClone(fresh);
  out.profiles = rebaseList(base.profiles, mine.profiles, out.profiles);
  out.fixtures = rebaseList(base.fixtures, mine.fixtures, out.fixtures);
  out.groups = rebaseList(base.groups, mine.groups, out.groups);

  // A type deleted here that a fixture in the new show still uses stays.
  const used = new Set(out.fixtures.map((f) => f.profile));
  for (const p of fresh.profiles) {
    if (used.has(p.id) && !out.profiles.some((x) => x.id === p.id)) out.profiles.push(structuredClone(p));
  }
  // A group lists only fixtures that are there (one deleted here leaves every group, the new show's too).
  const fixtures = new Set(out.fixtures.map((f) => f.id));
  for (const g of out.groups) g.fixtures = g.fixtures.filter((id) => fixtures.has(id));

  // A group deleted here takes its presets, its part in every look, and its place on the operator page.
  const kept = new Set(mine.groups.map((g) => g.id));
  const gone = new Set(base.groups.map((g) => g.id).filter((id) => !kept.has(id)));
  if (gone.size) {
    out.presets = out.presets.filter((p) => !gone.has(p.group));
    for (const l of out.looks) l.groups = l.groups.filter((e) => !gone.has(e.group));
    out.operator.groups = out.operator.groups.filter((id) => !gone.has(id));
  }
  // A group added here goes on the operator page if this page put it there.
  const groups = new Set(out.groups.map((g) => g.id));
  const listed = new Set(base.operator.groups);
  for (const id of mine.operator.groups) {
    if (!listed.has(id) && groups.has(id) && out.operator.groups.length && !out.operator.groups.includes(id)) out.operator.groups.push(id);
  }
  return out;
}

/** One list of things with ids: `fresh` with the ones changed or added between `base` and `mine` taken, and the deleted ones gone. */
function rebaseList(base, mine, fresh) {
  const before = new Map(base.map((x) => [x.id, JSON.stringify(x)]));
  const now = new Set(mine.map((x) => x.id));
  const out = fresh.filter((x) => !before.has(x.id) || now.has(x.id));
  for (const x of mine) {
    if (before.get(x.id) === JSON.stringify(x)) continue;
    const k = out.findIndex((y) => y.id === x.id);
    if (k >= 0) out[k] = structuredClone(x);
    else out.push(structuredClone(x));
  }
  return out;
}
