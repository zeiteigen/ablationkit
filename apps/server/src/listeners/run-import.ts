/**
 * Historical-run import (ADR 0043): agents (onboarding a project) and the researcher turn a run
 * that happened outside AblationKit into a labelled MLflow run of the project.
 */
import { json, readJsonBody } from "../http.ts";
import { importRun } from "../research/run-import.ts";
import type { TaskOp } from "./tasks.ts";

export const RUN_IMPORT_OPS: readonly TaskOp[] = [
  {
    method: "POST",
    path: "/api/v1/projects/:id/run-imports",
    action: "tracking.run.import",
    agent: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const r = await importRun(c.svc, c.params["id"] as string, body, c.actor);
      return json(r.mlflow_run_id ? 201 : 202, r);
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/run-imports",
    action: "tracking.run.import.list",
    agent: true,
    run: (c) => {
      const imports = c.svc.tracking.mappings
        .forProject(c.params["id"] as string)
        .filter((m) => m.kind === "import")
        .map((m) => ({
          ref: m.ref,
          source: m.import_source,
          run_name: m.run_name,
          mlflow_run_id: m.mlflow_run_id,
          sync_state: m.sync_state,
          study_id: m.study_id,
          variant_id: m.variant_id,
          created_at: m.created_at,
        }));
      return json(200, { imports, total: imports.length });
    },
  },
];
