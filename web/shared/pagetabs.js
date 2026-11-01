// The tabs to the four pages, the same on every page's top bar: an icon each, the open page lit, its name on hover
// or a long press (the title). The nav is `<nav class="ds-pagetabs" data-page="operator|patch|settings|timeline">`;
// CSS gives it its width before this fills it, so the bar doesn't move when the page loads.

const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

/** The pages in their order: id, name, address, and the icon's inside (24 × 24, drawn with lines). */
export const PAGES = [
  ['operator', 'Operator', '/operator/', '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>'],
  ['patch', 'Patch', '/patch/', '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>'],
  ['settings', 'Settings', '/settings/', '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'],
  ['timeline', 'Timeline', '/timeline/', '<rect x="3" y="5" width="9" height="5" rx="1.5"/><rect x="9" y="14" width="12" height="5" rx="1.5"/><path d="M15 3v4M15 10v2"/>'],
];

/** Fills `nav` with a link per page; the one named by its `data-page` is marked as the page you are on. */
export function setupPageTabs(nav) {
  const here = nav.dataset.page;
  nav.innerHTML = PAGES.map(([id, name, href, icon]) => {
    const current = id === here ? ' aria-current="page"' : '';
    return `<a href="${href}" aria-label="${name}" title="${name}"${current}><svg width="20" height="20" viewBox="0 0 24 24" ${STROKE} aria-hidden="true">${icon}</svg></a>`;
  }).join('');
}
