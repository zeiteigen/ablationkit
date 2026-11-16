# Core contracts

- [Protocol schemas](protocol.md): generated from `packages/protocol`; never edit by hand.
- [Storage layouts](storage.md): JSON snapshot, JSONL journal and migration rules.

- [Coordinator API](coordinator-api.md): login socket, human, agent and worker listeners, SSE events.
- [MLflow feature compatibility matrix](mlflow-compatibility.md): every MLflow capability AblationKit uses on the pinned MLflow, where it is used and which real-MLflow suite runs it (criterion 18; generated).

Drift checks (CI): the coordinator API tables are compared with the listeners' route tables in both directions (`apps/server/test/api-docs.test.ts`); every `ablationkit` command, `bun run` script and relative link in the maintained docs is checked by `apps/cli/test/docs-drift.test.ts`; the protocol reference by `bun run protocol:check`; the MLflow matrix by `bun run mlflow:matrix` and `packages/tracking-mlflow/test/feature-matrix.test.ts`.

A new route goes in the coordinator API tables in the same change.
