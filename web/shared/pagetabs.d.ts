// Types for pagetabs.js (plain JS for the pages, imported by the server tests).

/** The pages in their order: id, name, address, and the icon's inside. */
export const PAGES: [id: string, name: string, href: string, icon: string][];

/** Fills `nav` with a link per page; the one named by its `data-page` is marked as the page you are on. */
export function setupPageTabs(nav: { dataset: { page?: string }; innerHTML: string }): void;
