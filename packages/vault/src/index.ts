/**
 * The vault's pure logic (ADR 0049): what a note's text embeds and links, the tree those embeds
 * make, the ledger, and the checks; and the library of prior work notes cite, with its citations
 * (ADR 0052); the witness, which holds notes against the runs they report (ADR 0056). Shared by the coordinator, the CLI and the web UI. The Markdown form
 * (`@ablationkit/vault/markdown`) is separate because it needs Bun.
 */
export * from "./agenda.ts";
export * from "./checks.ts";
export * from "./graph.ts";
export * from "./text.ts";
export * from "./witness.ts";
export * from "./works.ts";
