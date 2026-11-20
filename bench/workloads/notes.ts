/** The notes of the two many-docs workloads: a title and a body typed in EDITS changes. Writing and checking take their text from here. */
export const EDITS = 20;

export const noteTitle = (i: number) => `note ${i}`;
export const noteLine = (i: number, edit: number) => `line ${edit} of note ${i}\n`;
export const noteBody = (i: number) => Array.from({ length: EDITS }, (_, e) => noteLine(i, e)).join("");
