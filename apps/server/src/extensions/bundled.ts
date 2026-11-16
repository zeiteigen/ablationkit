/** Product distribution catalog. Bundles receive no private coordinator APIs. */

import { resolve } from "node:path";
import { manifest } from "@ablationkit/builtin-llm/manifest";
import { migratePolicy } from "@ablationkit/builtin-llm/migrate-policy";
export const BUNDLED_EXTENSIONS = [
  {
    manifest,
    migratePolicy,
    legacyBridges: Object.fromEntries(
      ["llm.infer", "llm.compare", "traces.get", "evaluations.examples"].map((method) => [
        method,
        { plan: "compat.plan", execute: "compat.execute" },
      ]),
    ),
    root: resolve(import.meta.dir, "../../../../packages/builtin-llm/src"),
  },
];
