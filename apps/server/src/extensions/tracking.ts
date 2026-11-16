/** Project-scoped MLflow capabilities for managed extension backends. No raw HTTP capability
 * crosses this boundary; returned Responses and binary artifact payloads retain their types. */
import { applyCapture, type CapturePolicyLike, type RawSpan } from "@ablationkit/data-controls";
import type {
  MlflowClient,
  MlflowRegisteredModel,
  MlflowTraceInfo,
} from "@ablationkit/tracking-mlflow";
import { HttpError } from "../http.ts";
import { captureTraceInfo, historicalCapture } from "./capture.ts";

type Json = Record<string, unknown>;
export interface ExtensionTrackingScope {
  client: MlflowClient;
  projectId: string;
  experimentIds: () => string[];
  ensureExperiment: () => Promise<string>;
  writable: boolean;
  capture?: CapturePolicyLike | undefined;
}

const READ_METHODS = new Set([
  "getRun",
  "searchRuns",
  "listArtifacts",
  "downloadArtifact",
  "searchRegisteredModels",
  "getRegisteredModel",
  "getModelVersion",
  "searchModelVersions",
  "getVersionByAlias",
  "searchTraces",
  "getTraceInfo",
  "getTraceSpans",
  "getGenaiDataset",
]);
const WRITE_METHODS = new Set([
  "createRun",
  "updateRun",
  "setTag",
  "logBatch",
  "deleteRun",
  "uploadArtifact",
  "createRegisteredModel",
  "createModelVersion",
  "setAlias",
  "deleteAlias",
  "startTrace",
  "uploadTraceSpans",
  "setTraceTag",
  "createAssessment",
  "deleteTraces",
  "createGenaiDataset",
  "upsertGenaiDatasetRecords",
]);
const PROJECT_TAG = "ablationkit.project";
const EXPERIMENT_TAG = "_mlflow_experiment_ids";

function invalid(message: string): never {
  throw new HttpError(400, "invalid_request", message);
}
function denied(): never {
  throw new HttpError(
    403,
    "extension_tracking_scope",
    "MLflow object is outside this extension's project scope",
  );
}
function object(value: unknown): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid("Expected an MLflow argument object");
  return value as Json;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.length) invalid("Expected a nonempty MLflow identifier");
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length))
    invalid("Expected experiment or trace identifiers");
  return value as string[];
}
function artifactPath(value: unknown, optional = false): void {
  if (optional && value === undefined) return;
  const path = string(value);
  if (
    /[\\%?#]/.test(path) ||
    [...path].some((character) => character.charCodeAt(0) < 32) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    invalid("Artifact paths must be relative paths without traversal");
}

/** The allowlist is deliberately explicit; adding a client method requires a scope decision. */
export async function callExtensionTracking(
  scope: ExtensionTrackingScope,
  method: string,
  args: unknown[],
): Promise<unknown> {
  if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method))
    throw new HttpError(
      403,
      "extension_tracking_method",
      `MLflow method ${method} is not available to extensions`,
    );
  if (WRITE_METHODS.has(method) && !scope.writable)
    throw new HttpError(
      403,
      "extension_tracking_read_only",
      "This extension has read-only tracking access",
    );
  if (!Array.isArray(args)) invalid("MLflow arguments must be an array");
  const { client } = scope;
  const allowed = new Set(scope.experimentIds());
  const ownExperiment = (id: string): void => {
    if (!allowed.has(id)) denied();
  };
  const experimentIds = (value: unknown): string[] => {
    const ids = value === undefined ? [...allowed] : strings(value);
    if (!ids.length) denied(); // Never send an empty experiment list that a server might treat as global.
    for (const id of ids) ownExperiment(id);
    return [...new Set(ids)];
  };
  const primary = async (): Promise<string> => {
    const id = await scope.ensureExperiment();
    // ensureExperiment is a trusted host function and can create the first project experiment.
    allowed.add(id);
    return id;
  };
  const run = async (id: unknown) => {
    const result = await client.getRun(string(id));
    ownExperiment(result.info.experiment_id);
    return result;
  };
  const traceOwned = (info: MlflowTraceInfo): boolean =>
    info.trace_location?.type === "MLFLOW_EXPERIMENT" &&
    allowed.has(info.trace_location.mlflow_experiment?.experiment_id ?? "");
  const trace = async (id: unknown) => {
    const result = await client.getTraceInfo(string(id));
    if (!traceOwned(result)) denied();
    return result;
  };
  const modelOwned = (model: MlflowRegisteredModel): boolean => {
    const tags = Object.fromEntries((model.tags ?? []).map((tag) => [tag.key, tag.value]));
    return (
      tags[PROJECT_TAG] === scope.projectId ||
      (tags[EXPERIMENT_TAG] ?? "").split(",").some((id) => allowed.has(id))
    );
  };
  const model = async (name: unknown) => {
    const result = await client.getRegisteredModel(string(name));
    if (!modelOwned(result)) denied();
    return result;
  };
  const projectTags = (value: unknown): { key: string; value: string }[] => {
    if (value === undefined) return [{ key: PROJECT_TAG, value: scope.projectId }];
    if (!Array.isArray(value)) invalid("MLflow tags must be an array");
    return [
      ...value
        .map((tag) => {
          const item = object(tag);
          return {
            key: string(item["key"]),
            value:
              typeof item["value"] === "string"
                ? item["value"]
                : invalid("MLflow tag values must be strings"),
          };
        })
        .filter((tag) => tag.key !== PROJECT_TAG),
      { key: PROJECT_TAG, value: scope.projectId },
    ];
  };
  const dataset = async (id: unknown): Promise<Json> => {
    // This pinned REST operation has no typed client wrapper yet. It is never caller-selected.
    const response = await client.raw(
      "GET",
      `/api/3.0/mlflow/datasets/${encodeURIComponent(string(id))}`,
    );
    const result = object(object(await response.json())["dataset"]);
    experimentIds(result["experiment_ids"] ?? []);
    return result;
  };
  const invoke = (values: unknown[] = args): Promise<unknown> => {
    const fn = client[method as keyof MlflowClient];
    if (typeof fn !== "function") invalid("MLflow method is unavailable");
    return Reflect.apply(fn, client, values) as Promise<unknown>;
  };

  switch (method) {
    case "createRun": {
      const input = object(args[0]);
      return invoke([
        { ...input, experiment_id: await primary(), tags: projectTags(input["tags"]) },
      ]);
    }
    case "getRun":
      return run(args[0]);
    case "updateRun":
      await run(object(args[0])["run_id"]);
      return invoke();
    case "setTag":
      // Run-scoped, and never the project tag that scopes the run.
      await run(args[0]);
      if (string(args[1]) === PROJECT_TAG) denied();
      return invoke();
    case "logBatch": {
      const input = object(args[0]);
      await run(input["run_id"]);
      if (input["tags"] !== undefined && !Array.isArray(input["tags"]))
        invalid("MLflow tags must be an array");
      if (((input["tags"] ?? []) as unknown[]).some((t) => object(t)["key"] === PROJECT_TAG))
        denied();
      return invoke();
    }
    case "deleteRun":
      await run(args[0]);
      return invoke();
    case "listArtifacts":
      await run(args[0]);
      artifactPath(args[1], true);
      return invoke();
    case "downloadArtifact":
      await run(args[0]);
      artifactPath(args[1]);
      return invoke();
    case "uploadArtifact": {
      const actual = await run(object(args[0])["run_id"]);
      artifactPath(args[1]);
      return invoke([actual.info, args[1], args[2]]);
    }
    case "searchRuns": {
      const input = object(args[0]);
      const page = await client.searchRuns({
        ...input,
        experiment_ids: experimentIds(input["experiment_ids"]),
      });
      return { ...page, items: page.items.filter((item) => allowed.has(item.info.experiment_id)) };
    }
    case "startTrace": {
      if (scope.capture?.mode === "off")
        throw new HttpError(
          403,
          "extension_capture_off",
          "Trace capture is disabled for this project",
        );
      const input = object(args[0]);
      const metadata = input["trace_metadata"] === undefined ? {} : object(input["trace_metadata"]);
      if (metadata["mlflow.sourceRun"] !== undefined) await run(metadata["mlflow.sourceRun"]);
      const tags = input["tags"] === undefined ? {} : object(input["tags"]);
      // MLflow owns this location; accepting it from extension input could redirect a later upload.
      const { "mlflow.artifactLocation": _location, ...safeTags } = tags;
      const created = await invoke([
        captureTraceInfo(
          {
            ...input,
            trace_location: {
              type: "MLFLOW_EXPERIMENT",
              mlflow_experiment: { experiment_id: await primary() },
            },
            tags: { ...safeTags, [PROJECT_TAG]: scope.projectId },
          } as unknown as MlflowTraceInfo,
          scope.capture,
        ),
      ]);
      return captureTraceInfo(created as MlflowTraceInfo, scope.capture);
    }
    case "searchTraces": {
      const input = object(args[0]);
      const page = await client.searchTraces({
        ...input,
        experiment_ids: experimentIds(input["experiment_ids"]),
      });
      return {
        ...page,
        items: page.items.filter(traceOwned).map((info) => captureTraceInfo(info, scope.capture)),
      };
    }
    case "getTraceInfo":
      return captureTraceInfo(await trace(args[0]), scope.capture);
    case "getTraceSpans": {
      await trace(args[0]);
      const spans = await client.getTraceSpans(string(args[0]));
      return scope.capture
        ? applyCapture(spans as RawSpan[], historicalCapture(scope.capture)).spans
        : spans;
    }
    case "uploadTraceSpans": {
      const actual = await trace(object(args[0])["trace_id"]);
      if (!Array.isArray(args[1])) invalid("Trace spans must be an array");
      const spans = scope.capture
        ? applyCapture(args[1] as RawSpan[], historicalCapture(scope.capture)).spans
        : args[1];
      return invoke([actual, spans]);
    }
    case "setTraceTag": {
      await trace(args[0]);
      const key = string(args[1]);
      if (key === "mlflow.artifactLocation") denied();
      return invoke([args[0], key, key === PROJECT_TAG ? scope.projectId : args[2]]);
    }
    case "createAssessment":
      await trace(args[0]);
      return invoke();
    case "deleteTraces": {
      const input = object(args[0]);
      ownExperiment(string(input["experiment_id"]));
      if (input["trace_ids"] !== undefined) {
        for (const id of strings(input["trace_ids"])) await trace(id);
      }
      return invoke();
    }
    case "searchRegisteredModels": {
      const page = await client.searchRegisteredModels(object(args[0]));
      return { ...page, items: page.items.filter(modelOwned) };
    }
    case "getRegisteredModel":
      return model(args[0]);
    case "createRegisteredModel": {
      const input = object(args[0]);
      const tags = projectTags(input["tags"]);
      for (const tag of tags)
        if (tag.key === EXPERIMENT_TAG) experimentIds(tag.value.split(",").filter(Boolean));
      return invoke([{ ...input, tags }]);
    }
    case "createModelVersion": {
      const input = object(args[0]);
      await model(input["name"]);
      if (input["run_id"] !== undefined) await run(input["run_id"]);
      return invoke();
    }
    case "getModelVersion":
    case "getVersionByAlias":
    case "setAlias":
    case "deleteAlias":
      await model(args[0]);
      return invoke();
    case "searchModelVersions": {
      const page = await client.searchModelVersions(object(args[0]));
      const names = new Map<string, boolean>();
      for (const item of page.items) {
        if (!names.has(item.name))
          names.set(item.name, modelOwned(await client.getRegisteredModel(item.name)));
      }
      return { ...page, items: page.items.filter((item) => names.get(item.name)) };
    }
    case "createGenaiDataset": {
      const input = object(args[0]);
      return invoke([
        {
          ...input,
          experiment_ids: experimentIds(input["experiment_ids"]),
          tags: {
            ...(input["tags"] === undefined ? {} : object(input["tags"])),
            [PROJECT_TAG]: scope.projectId,
          },
        },
      ]);
    }
    case "getGenaiDataset":
      return dataset(args[0]);
    case "upsertGenaiDatasetRecords":
      await dataset(args[0]);
      return invoke();
    default:
      throw new HttpError(403, "extension_tracking_method", "MLflow method is unavailable");
  }
}
