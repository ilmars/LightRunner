// Types for names.js (plain JS for the pages, imported by the server tests).

export function colourWord(hex: string | null | undefined): string;
export function listNames(names: string[]): string;
export function effectSuggestion(colourNames: (string | null)[], kind: string): string;
export function lookSuggestion(labels: (string | null)[]): string;
export function uniqueName(name: string, taken: Iterable<string>): string;
