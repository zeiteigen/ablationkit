/** One-time import of previously authorized settings; leaves legacy data files in place. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "@ablationkit/core";
import { validateLlmSettings } from "@ablationkit/protocol";
import { DEFAULT_CAPTURE } from "./llm-settings.ts";

export function migratePolicy(stateDir: string, pid: string) {
  const file = join(stateDir, pid, "llm", "settings.json");
  const settings = existsSync(file)
    ? readJson(file, validateLlmSettings)
    : { providers: [], capture: DEFAULT_CAPTURE };
  return {
    destinations: settings.providers.map((provider) => ({
      id: provider.provider_id,
      base_url: provider.base_url,
      ...(provider.api_key_env ? { credential_env: provider.api_key_env } : {}),
      models: provider.models,
      metadata_paths: ["models"],
      allow_external: provider.locality === "local" || !!provider.egress,
      allow_dataset: provider.locality === "local" || !!provider.egress?.allow_datasets,
    })),
    capture: settings.capture,
  };
}
