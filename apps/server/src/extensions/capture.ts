/** Project-wide capture combines extension constraints; one extension cannot widen another. */
import {
  BUILTIN_REDACTIONS,
  type BuiltinRedaction,
  type CapturePolicyLike,
  captureMetadata,
  capturePreview,
  redactor,
} from "@ablationkit/data-controls";
import type { MlflowTraceInfo } from "@ablationkit/tracking-mlflow";
import type { ExtensionCapturePolicy } from "./policy.ts";

const RANK = { off: 0, metadata_only: 1, redacted: 2, full: 3 } as const;

export function projectCapture(
  policies: readonly ExtensionCapturePolicy[],
): CapturePolicyLike | undefined {
  if (!policies.length) return undefined;
  let mode: CapturePolicyLike["mode"] = "full";
  const builtins = new Set<BuiltinRedaction>();
  const patterns = new Map<string, { name: string; regex: string }>();
  for (const policy of policies) {
    if (RANK[policy.mode] < RANK[mode]) mode = policy.mode;
    for (const builtin of policy.builtin_redactions ?? []) {
      if (Object.hasOwn(BUILTIN_REDACTIONS, builtin)) builtins.add(builtin as BuiltinRedaction);
    }
    for (const pattern of [
      ...(policy.patterns ?? []),
      ...(policy.redaction_patterns ?? []).map((regex) => ({ name: "pattern", regex })),
    ]) {
      // Deduplicate regexes, never names: two extensions can use the same name for different rules.
      if (!patterns.has(pattern.regex)) patterns.set(pattern.regex, { ...pattern });
    }
  }
  return { mode, builtin_redactions: [...builtins], patterns: [...patterns.values()] };
}

/** Disabling new capture still permits inspecting the metadata of historical traces. */
export function historicalCapture(policy: CapturePolicyLike): CapturePolicyLike {
  return policy.mode === "off" ? { ...policy, mode: "metadata_only" } : policy;
}

/** Apply the current rules again to traces recorded under an older, less restrictive policy. */
export function captureTraceInfo(
  info: MlflowTraceInfo,
  policy: CapturePolicyLike | undefined,
): MlflowTraceInfo {
  if (!policy || policy.mode === "full") return info;
  const current = historicalCapture(policy);
  const r = redactor(current);
  const text = (value: string | undefined) => capturePreview(value, current);
  const request = text(info.request_preview);
  const response = text(info.response_preview);
  const {
    request_preview: _request,
    response_preview: _response,
    trace_metadata: metadata,
    assessments,
    ...rest
  } = info;
  return {
    ...rest,
    ...(request === undefined ? {} : { request_preview: request }),
    ...(response === undefined ? {} : { response_preview: response }),
    ...(metadata === undefined ? {} : { trace_metadata: captureMetadata(metadata, current) }),
    ...(assessments === undefined
      ? {}
      : {
          assessments: assessments.map((assessment) => {
            const { rationale, feedback, expectation, ...details } = assessment;
            const safeRationale = text(rationale);
            const value = (item: unknown): unknown =>
              current.mode === "redacted"
                ? r.value(item)
                : typeof item === "boolean" || typeof item === "number" || item === null
                  ? item
                  : undefined;
            const feedbackValue = feedback ? value(feedback.value) : undefined;
            const expectationValue = expectation ? value(expectation.value) : undefined;
            const safeError = text(feedback?.error?.error_message);
            return {
              ...details,
              ...(safeRationale === undefined ? {} : { rationale: safeRationale }),
              ...(feedback === undefined
                ? {}
                : {
                    feedback: {
                      value: feedbackValue ?? null,
                      ...(feedback.error
                        ? {
                            error: {
                              ...(feedback.error.error_code === undefined
                                ? {}
                                : { error_code: feedback.error.error_code }),
                              ...(safeError === undefined ? {} : { error_message: safeError }),
                            },
                          }
                        : {}),
                    },
                  }),
              ...(expectationValue === undefined
                ? {}
                : { expectation: { value: expectationValue } }),
            };
          }),
        }),
  };
}
