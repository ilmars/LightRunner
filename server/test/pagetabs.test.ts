// The page tabs on every page's top bar (web/shared/pagetabs.js): the same four links everywhere, the open page marked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAGES, setupPageTabs } from '../../web/shared/pagetabs.js';

const web = fileURLToPath(new URL('../../web/', import.meta.url));

test('the tabs link the four pages in order and mark only the open one', () => {
  const nav = { dataset: { page: 'settings' }, innerHTML: '' };
  setupPageTabs(nav);
  const links = [...nav.innerHTML.matchAll(/<a href="([^"]+)" aria-label="([^"]+)"[^>]*?( aria-current="page")?>/g)];
  assert.deepEqual(links.map((m) => m[1]), ['/operator/', '/patch/', '/settings/', '/timeline/']);
  assert.deepEqual(links.map((m) => m[2]), ['Operator', 'Patch', 'Settings', 'Timeline']);
  assert.deepEqual(links.map((m) => Boolean(m[3])), [false, false, true, false]);
  assert.equal((nav.innerHTML.match(/<svg /g) ?? []).length, 4, 'an icon each');
});

test('every page has the tabs, naming itself, and a Full screen button', () => {
  for (const [id] of PAGES) {
    const html = readFileSync(`${web}${id}/index.html`, 'utf8');
    assert.match(html, new RegExp(`<nav [^>]*class="ds-pagetabs" data-page="${id}"`), id);
    assert.match(html, /<button id="fsBtn" class="ds-iconbtn"/, id);
    assert.ok(!html.includes('class="applinks"'), `${id}: the old word links are gone`);
  }
});
