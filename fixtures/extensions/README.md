# Extension fixtures

Standalone Level 1 extensions used by the coordinator's extension tests
(`apps/server/test/extensions.test.ts`). Tests copy them into a temporary project checkout under
`.ablationkit/extensions/<id>/`. They are not workspace members.

- `run-inspector`: a `run.tab` and a `project.panel` (React), plus a `project.action` that creates a note.
- `py-evaluator`: Python-only (`run.evaluator`, `project.analysis`), stdlib only, with entries that
  deliberately exceed limits or probe the network for the limit and isolation tests.
- `iris-demo`: a `model.demo` that predicts through the `inference.predict` bridge with an allowlisted model.
