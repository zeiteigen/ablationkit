#!/usr/bin/env bun
/** `bun main.ts --spool <dir>`: run one attempt's collector (launched by the coordinator). */
import { Collector } from "./collector.ts";

const i = process.argv.indexOf("--spool");
const spool = i >= 0 ? process.argv[i + 1] : undefined;
if (!spool) {
  console.error("usage: collector --spool <dir>");
  process.exit(2);
}
try {
  const code = await new Collector({ spool }).run();
  process.exit(code);
} catch (e) {
  console.error(`collector: fatal: ${(e as Error).stack ?? String(e)}`);
  process.exit(1);
}
