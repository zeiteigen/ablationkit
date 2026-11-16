/**
 * MLflow feature-use trace for the compatibility matrix (criterion 18; `scripts/mlflow-matrix.ts`).
 *
 * When `ABLATIONKIT_MLFLOW_TRACE` names a file, every MLflow REST call the client makes is appended
 * as `SUITE rest METHOD PATH STATUS` and every operations-bridge op as `SUITE bridge OP
 * ok|error|none`, where SUITE is `ABLATIONKIT_MLFLOW_TRACE_SUITE` (or `-`). The
 * real-MLflow CI suites set it; the matrix check then proves each listed feature ran against the
 * pinned MLflow. Off (and free) otherwise. Paths only: never bodies, queries or credentials.
 */
import { appendFileSync } from "node:fs";

export function recordMlflowUse(line: string): void {
  const file = process.env["ABLATIONKIT_MLFLOW_TRACE"];
  if (!file) return;
  try {
    appendFileSync(file, `${process.env["ABLATIONKIT_MLFLOW_TRACE_SUITE"] || "-"} ${line}\n`);
  } catch {
    // Diagnostics only: a failed trace write never affects the request.
  }
}
