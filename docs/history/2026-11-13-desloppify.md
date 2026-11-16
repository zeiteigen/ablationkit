# DESLOP: desloppify pass, 2026-11-13

A pass over the whole repository for the same behaviour in less, plainer code (steps 1-3 of the
desloppify method: delete dead code, collapse pass-through layers, merge duplicates). Structural
re-architecture (step 4) was not started: it needs the researcher's go-ahead, and its proposals are
at the end.

## 1. Baseline (main at db165c7)

| Area | Files | Source LOC (ts/tsx/py, excl. tests) | Test LOC |
| --- | ---: | ---: | ---: |
| apps/server | 145 | 31,554 | 21,794 |
| apps/web | 82 | 22,079 | 3,202 |
| apps/cli | 31 | 5,434 | 3,335 |
| apps/desktop | 13 | 819 | 359 |
| packages/builtin-llm | 36 | 10,061 | 321 |
| packages/protocol | 134 | 6,241 | 331 |
| packages/tracking-mlflow | 21 | 4,513 | 1,160 |
| packages/extension-host | 9 | 1,705 | 507 |
| packages/vault | 9 | 1,401 | 685 |
| other packages (10) | 61 | 6,826 | 2,175 |
| python/ | 33 | 7,777 | 1,178 |
| scripts/ | 12 | 1,930 | 511 |

All tracked text outside `design/` and `fixtures/`: about 153k lines. 15 workspace packages,
4 apps, 5 Python workspace members.

Checks at baseline: `bun run typecheck` pass; `bun test --parallel` 1052 pass, 71 skip, 0 fail;
`uv run --frozen pytest` pass; `bun run protocol:check` pass. `bun run lint` and
`format:check` fail only because Biome finds a second root `biome.json` inside an untracked Git
worktree under `.claude/worktrees/`; on the tracked tree (`biome lint apps packages scripts
templates fixtures`) both pass, and ruff passes.

Tools used (run from a scratch directory, not added to the repo): knip 5 (dead files and exports),
jscpd 4 (duplication: 0.96% of lines, 11 clones of 12+ lines).

## 2. Behaviour pinned at the boundary

The repository already pins its outer behaviour more thoroughly than a pass like this could add in
a night: route tests per listener (`apps/server/test/*`), the MCP server's tool list and calls
(`apps/cli/test/mcp.test.ts`), CLI usage and drift tests against `docs/cli.md` and
`docs/api/coordinator-api.md`, the protocol drift check, the security suite named by the threat
map, and the Playwright smoke test of the web shell against a real coordinator. These were treated
as the frozen boundary. No differential harness was built: the boundary suites already exercise the
coordinator over HTTP and the MCP server over JSON-RPC.

## 3. What the system does

In: researcher actions (web UI, CLI over the human listener), agent calls (`ablationkit mcp` over
the agent listener), worker reports (the collector over the worker listener). Out: HTTP responses,
MCP results, events (SSE), notifications, files written to the coordinator home and to MLflow.
State: validated JSON and JSONL journals under the coordinator home (`state/<project>/…`, `auth/`,
`events/`), MLflow (runs, models, datasets, traces) as the tracking store.

Core types and operations: projects (register, doctor, remove), jobs and attempts (submit within
policy and compute limit, supervise, collect, cancel), runs and studies (track, describe, compare),
the vault (notes, notebooks, ledger, checks, reads, works, figures), tasks (create, complete with
evidence), extensions (validate, build, run in a sandbox), models and evaluations (MLflow
lifecycle, GenAI evaluations through the bridge).

Essential complexity: the policy and compute admission, process supervision and crash recovery,
the MLflow outbox and reconciliation, the extension sandbox, the vault's checks. Accidental: copied
helpers between the coordinator and the bundled LLM backend, re-export shims left by moves,
duplicated route tables between listeners, over-exported internals.

## 4. Method

Four agents worked in parallel, each in its own worktree on one area (the coordinator; the web
shell and the LLM backend's page; the CLI, desktop shell and scripts; the packages and Python),
committing after every green step. Each branch was reviewed, rebased onto `main` and fast-forwarded,
so every step is its own commit and can be reverted alone. The CLI agent snapshotted the MCP
server's `initialize` and `tools/list` output and every operation called with required, all, no and
unknown arguments, about 60 CLI help/usage/error invocations, and the HTTP client against a scripted
server, before any change; all three snapshots are byte-identical on the merged `main`.

## 5. What was removed, collapsed and merged

**Dead code and shims (deleted).** The coordinator's eight one-line LLM re-export files and
`listeners/llm.ts` (nothing imported them); the bundled LLM backend's `operations.ts` (type aliases
plus an error class nothing threw, so its `instanceof` branch was dead) and its `http.ts` copy;
helpers no production code calls (`TokenStore.prune` and `revokeForAttempt`, core
`removeJsonFile`, `scorerMeans`, `TraceService.evaluationTags`, `MappingStore.allLinks`,
`FakeMlflow.addAssessment`, two unused protocol validators, `JOB_EVENT_TYPES`, research `refKey`,
`treeBytes`, `loadMounts`, …); props no caller passes; the agent dock's CSS (the dock left with
ADR 0039) and `.callout`; `method`/`path`/`agent` on the 35 `LLM_OPS` entries (the coordinator builds
routes from the manifest; a script confirmed all 35 matched before removal); a remote-worker
parameter never read.

**Duplicates (merged).** `HttpError`/`json`/`readJsonBody` (coordinator and LLM backend) now live
once in `@ablationkit/core/http`; the agent and human listeners' duplicated op-route mappers; three
identical `sha256File` copies in the coordinator; listener helpers `intParam`, `stringList`,
`session` and the human `audit`; one job-console response for both listeners; one loopback-host
list; the CLI's three "fetch with bearer, map the error body" paths (`client.ts`); the vault
import/export loops; `target add` for Runpod and Colab; Runpod's find-or-create-pod logic
(`ensurePod`); the CLI tests' eleven copies of temp-dir/coordinator/output-capture setup
(`apps/cli/test/helpers.ts`; titles, files and assertions unchanged); three record-row renderers on
the project overview; the external-link code in the desktop shell.

**Pass-through and ceremony (collapsed).** A one-method interface in `access.ts` became a function;
redundant argument guards in two MCP operations (`checkArgs` already enforces them); the LLM page's
copied web primitives trimmed to what it uses (it is a separate frame bundle and cannot import the
shell's copies, see §8); about thirty internals that were exported but used only by their own
module are no longer exported.

## 6. Before and after

| | Before (db165c7) | After |
| --- | ---: | ---: |
| Tracked text outside design/ and fixtures/ | 153,276 | 152,079 (−1,197) |
| apps/server source (excl. tests) | 31,554 | 31,335 |
| apps/cli source / tests | 5,434 / 3,335 | 5,350 / 3,070 |
| packages source (excl. tests) | 30,656 | 30,136 |
| Files changed | | 111 (+574, −1,770) |
| Workspace packages / apps | 15 / 4 | 15 / 4 |
| Runtime dependencies | | unchanged |
| `bun test` | 1052 pass, 71 skip | 1051 pass, 71 skip (one unit test went with `removeJsonFile`) |

The honest summary: this codebase was not sloppy in the usual sense. Duplication was under 1%,
`tsc --noUnusedLocals --noUnusedParameters` found nothing in the web code, and most knip findings
were false positives (files loaded by manifest or spawned by path). The large wins left are concept
deletions and structural moves that need a decision (§9).

## 7. Bugs found and preserved (not fixed: each wants its own commit and test)

1. `apps/cli/src/commands/dev-build.ts:45`: `--check=CMD` is silently ignored (only `--check CMD`
   is collected), so the default checks run instead.
2. `apps/cli/src/client.ts` (`exchangeCode`): a non-OK reply with no `error` object, or a non-JSON
   body (a proxy's HTML 502), throws a `TypeError`/`SyntaxError` instead of an `ApiError`.
3. MCP `agentApi`: a 2xx reply that is not JSON throws a `SyntaxError` that reaches the agent as
   `invalid_request`; `CoordinatorClient` returns `{}` in the same case.
4. `apps/web/src/components/BackendPage.tsx`: backend pages are always 900px tall; auto-sizing (as
   extension and figure frames do) was started and never finished.
5. Docs that describe code that does not exist: `docs/autonomy/deployment-gates.md:54` and ADR 0018
   give `launcher_unavailable` as a deployment failure reason (the real launcher rejects with
   `unsupported_deployment`, and the stored reason is the message); ADR 0008 says
   `revokeForAttempt` revokes an attempt's worker tokens on reconciliation (it was never called;
   worker tokens end through `markJobTerminal` plus a 7-day grace); ADR 0007 names
   `removeJsonFile`; `apps/desktop/src/main.ts:14-15` says notifications is the only permission
   granted, but `policy.ts:98` also grants `clipboard-sanitized-write`.
6. The bundled LLM evaluation's "bridge unavailable:" error prefix was never applied (the class it
   tested for was never thrown); stored errors have always been `String(e)`.
7. `agentApi` now omits the `Authorization` header when the token is an empty string (before it sent
   `Bearer `). Login-socket tokens are never empty, so this was accepted as unobservable.

One flaky test seen once under parallel load and green on every rerun:
`apps/server/test/tracking.test.ts` "a rejected write is sync_failed…".

## 8. Flagged, not changed

- **The LLM backend page's copies of web primitives** (`packages/builtin-llm/src/ui/`) and its
  `api.ts`: the page is bundled separately and served in an opaque-origin frame that talks over a
  MessagePort, so it cannot import the shell's `ApiError`/`navigate` (and ADR 0024 keeps backends on
  the public contract). Trimmed to what it uses instead of shared.
- **Frame handshake written three times** (`BackendPage.tsx`, `ExtensionFrame.tsx`, `Figure.tsx`):
  security-sensitive (threats EXT-*); left for a deliberate change with the security suite.
- **Audit helpers in `listeners/jobs.ts`, `remote.ts`, `lifecycle.ts`**: merging them would change
  the key order of persisted audit JSONL entries.
- **`compareVersions`, `canonicalJson`, `gitHead` vs `gitCommit`**: look alike, behave differently on
  edge cases that feed hashes and build IDs.
- **Python scripts that repeat a few lines** (`genai.py`, `ablationkit_llm/evaluate.py`, the ops
  bridge): they run in different processes and environments.
- **`apps/server/src/http.ts` re-exports `@ablationkit/core/http`** next to the coordinator's own
  error mapping, so coordinator modules keep one import. It is the only re-export left by this pass.

## 9. Proposed next steps (step 4: need the researcher's go-ahead)

Ordered by value. None started.

1. **Retire research records (ADR 0013) in favour of the vault (ADR 0049).** The biggest concept
   deletion available: `research.ts`, `research-export.ts`, `reviews.ts`, `reports.ts`,
   `listeners/research.ts`, `pages/knowledge.tsx`, `pages/review.tsx`, `components/Review.tsx`
   (about 3,600 lines) plus their MCP operations, protocol schemas, export and tests. Needs: a
   one-time distillation or archive of existing records (fraise and next-concept-prediction hold
   49), LLM trace links that can target notes, and a decision on read-only access to old records.
2. **One vault record store** (`apps/server/src/vault.ts`): notes and works repeat normalisation,
   save, change events, checks, create/update/remove. About 150-200 lines.
3. **Split `apps/cli/src/commands/mcp.ts` (2.4k lines)** into operations by domain plus tools and
   server modules; LOC-neutral, proven by the MCP snapshot.
4. **`experimentIds(pid)` on the tracking mappings**, used by models, extensions, shell and tracking
   (four copies; the extensions copy skips `registry.require`).
5. **A shared primitives module for frame pages** (Badge, Empty, KV, Loading, Tabs, useAction,
   format helpers, a transport-parameterised `useApi`): about 150 lines; needs a layering decision.
6. **One frame-host module** for the three frame handshakes: 60-80 lines, with the security suite.
7. Smaller: a confirm footer for the six modal dialogs (~50 lines), a `repeatable` flag option for
   `parseArgs` (~30; changes error text), an `emit()` helper for the CLI's ~40 JSON-or-text
   branches (~40), one "CLI usage lists this command" test helper (~20), a per-project JSON store in
   the LLM backend (~70; persisted layouts), `extension-host/src/cli.ts` folded into the CLI (~10).
