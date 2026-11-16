# Extension backends

An Extension Host 2 backend adds project-scoped services and declared HTTP operations to an
extension. Backend declarations are in the public
[`@ablationkit/extension-host/backend`](../../packages/extension-host/src/backend.ts) contract.
The coordinator starts the selected backend in a separate Bun process and gives it a bounded JSON
RPC channel. A backend does not import coordinator modules or receive the coordinator's `Services`
object.

Backends are trusted local code. The process runs under the user's OS account, with access to that
account's filesystem and direct network privileges. The host broker checks each call, but this is
not an OS filesystem or network sandbox. Use the network broker when a backend needs provider
access so destination policy, credential handling, request bounds and data rules apply.

## API versions

The current host API is **2.0.0**. Manifests that declare a backend must target API 2. Manifests
without a backend may continue to target API 1; the validator's API 1 compatibility rule does not
allow API 1 code to declare a backend.

The backend manifest declares the code entry, operations, pages, service names, ingestion kinds,
job SDKs and required capabilities. The coordinator registers operation routes and page routes from
the active backend bundle's manifest; its project router matches declared page paths, and
caller requirements (`agent`, `widens_data_controls`) come from operation metadata. Keep operation IDs stable because
clients use those IDs rather than calling backend object methods by name. Integrations should use
these public declarations and contracts, not server-private route or service modules.

## Runtime contract

The backend entry exports a default factory that receives `BackendContext` and returns a handler
with `call(method, params, {signal})`; an optional `shutdown()` is called when the process closes.
The host provides a project snapshot, current caller and signal per call, plus `call` and `notify`
functions for broker requests and notifications. RPC uses bounded newline-delimited JSON. The
codec supports JSON values, byte arrays, errors and `Response` objects. Child stdout is reserved
for the protocol; write diagnostics to stderr.

An operation is delivered as `call("operation", request, {signal})`; a service is delivered as
`call("service", request, {signal})`. Requests carry `invocation`, `actor`, and a refreshed
`snapshot`, plus `operation`/HTTP fields or `service`/`args`. Forward `invocation` unchanged in
broker envelopes so writes and notifications retain the host caller's identity:

```ts
import type { BackendContext } from "@ablationkit/extension-host/backend";

export default function createBackend(ctx: BackendContext) {
  return {
    async call(method: string, raw: unknown) {
      const request = raw as { invocation: string; operation?: string };
      if (method !== "operation" || request.operation !== "notes.list") {
        throw new Error("Unknown operation");
      }
      const notes = await ctx.call("research.list", {
        invocation: request.invocation,
        params: { query: {} },
      });
      return Response.json({ notes });
    },
  };
}
```

The manifest for this example declares `backend.execute`, `project.research.read` and an operation
`{id: "notes.list", method: "GET", path: "/notes", agent: true}`. Declare empty `pages`, `services`,
`ingest` and `job_sdks` arrays when unused. Requests without an invocation run as the extension's
maintenance agent; they cannot acquire widening authority, provider access or model execution.
Job ingestion also runs with a dedicated agent identity and no researcher execution or widening
authority.

Project-authored backends go through the existing immutable build and approval workflow.
The builder permits snapshot-relative source and public host APIs, rejects coordinator-private or
outside imports, and rejects macros rather than executing source during a build. Backend crashes
fail pending calls without replaying work; a failed backend does not prevent coordinator startup.

The coordinator resolves project routes against its registered backend bundle and that bundle's
manifest, then checks project scope, the declared operation/service, capabilities, caller
restrictions, data policy and size/time bounds on each request. For the bundled LLM backend, the
selected source is the `BUNDLED_EXTENSIONS` entry rooted at the shipped package tree; its
per-project activation record stores the enabled state, version and declared capabilities. This is
not a content-addressed Level 1 build approval. Each request receives a fresh project/caller
snapshot instead of live internal service objects. Tracking calls are scoped to the project's
experiment IDs; research, audit and event calls carry the project and caller from the host.

## Broker services

The public contract currently covers:

- **Tracking:** scoped MLflow client operations, plus project experiment creation. These go through
  the host's tracking broker, which checks experiment scope and read/write capability.
- **Research and events:** project-scoped record get/require/list/create/update and audit/event
  notifications. `events.read` replays bounded, project-scoped pages with an exclusive sequence
  cursor, optional type filters and a maximum of 1,000 events. Browser subscriptions use SSE
  `format=message` so custom extension event types need no core event-name registration.
- **Managed data:** JSON collections with schema version and optimistic revision checks, and
  immutable SHA-256-addressed blobs. Storage is coordinator-managed JSON/files, not SQL. Data
  persists when a backend is disabled. `data.migrate` takes `{collection, input: {from_version,
  to_version, records: [{key, expected_revision, value}]}}`; it advances exactly one schema
  version and atomically checks the complete key set and revisions before replacing any record.
- **Provider network:** destination-scoped HTTP requests with bounded bodies and timeouts,
  model/data-class checks, and credentials injected by the host. A backend receives credential
  names or handles, not secret values. The initial policy has no outbound destinations granted.
- **Extension services:** `services.call` requires the capability and a declared
  `uses_services: ["extension-id/service-name"]` dependency. The callee must export the service;
  `service_agents` determines whether an agent caller can use it. Caller identity and execution
  authority are preserved across the call.
- **Python operations:** supervised Python work through the operations bridge. Resource enforcement
  depends on the process supervisor; report the returned enforcement label accurately.

Data-control widening is enforced at the host. An operation that can widen capture, retention,
redaction or egress declares `widens_data_controls: true`. Such an operation is human-only (the
validator refuses it with `agent: true`), and a call to it by the researcher's session is the only
call during which the backend may widen its data controls; anywhere else a widening policy write is
refused with `widening_requires_confirmation`. The host derives widening authority from that
active operation declaration and caller context; backend RPC input cannot assert approval. Stored policies remain when a backend is disabled. The host combines all persisted capture rules
using the most restrictive mode and the union of redaction patterns, reapplies them to historical
trace reads and writes, and runs retention independently of active backend processes. Retention
deletes only from the project-owned experiment, never a linked experiment. If no ingestion adapter is
registered for a declared data kind, the coordinator rejects that ingestion.

## Bundled LLM research backend

`llm-research` is the first bundled backend. Its source in `packages/builtin-llm/` contains the
traces, prompts, golden sets, playground, evaluations, data controls, React page and Python GenAI
worker and portable Agent Skills. Its manifest declares the `/llm` operations, its page and its
compatibility services. Existing `/api/v1/projects/:id/llm/...` routes remain aliases and dispatch
through operation metadata. Its operations marked `agent: true` are MCP tools of `ablationkit mcp`
(`ablationkit_read llm.trace.search`, `ablationkit_read llm.prompt.diff`, …), generated from the manifest, so
agents reach each one with its path parameters and a `query` or `body` (ADR 0040).

The domain service still reads and writes the established files below the project's existing
`llm/` state directory. This migration preserves those files and does not rewrite them into the
generic JSON/blob store. New backend data can use that managed store. Disabling the LLM backend
stops its process but does not delete settings, provider policy, golden sets, evaluation records,
or evidence.

The bundled backend has no external destination grant by default. Configuring a provider does not
itself approve external or dataset egress. Settings that widen data rules go only through its
`llm.settings.widen` operation (`POST …/llm/settings/widen`, declared `widens_data_controls`); a
plain settings write that widens is refused with `widening_requires_confirmation`. They are
persisted by the coordinator's policy store. Safe mode disables all
extensions, including bundled backends; a project can also disable one backend independently.

## UI pages

Backend pages run in opaque-origin iframes with `sandbox="allow-scripts"`. A page says hello to the
trusted parent and receives a `MessagePort`; it sends requests, navigation and event
subscription messages over that port. The host verifies the sending frame, forwards only
project-scoped declared routes, and handles navigation in trusted UI. Do not
add a `fetch` path or import the coordinator's browser API client into a backend page. The bundled
LLM UI has a local API module that uses the parent port exclusively.

## Discover and invoke

Agents reach backends through `ablationkit mcp`: `ablationkit_read extension.operations` lists the
registered backend operations, pages and capabilities, and `ablationkit_do extension.call` invokes a
declared operation. The JSON envelope accepts `body`, route `params` and `path` (including a query
string). An agent session works in its own project and can invoke only operations marked
`agent: true`.

The HTTP endpoint is `POST /api/v1/projects/:id/extensions/:ext/operations/:operation`.
Operations declaring `widens_data_controls: true` use the same route with the researcher's session
on the human API; the agent listener refuses them (`human_only`). Input/output schemas support
the bounded JSON Schema subset documented in `backend-validation.ts`; unsupported keywords fail
validation. The old `/llm` paths are distribution-provided compatibility aliases to the same host.

`agent_skills` declares snapshot-relative skill directories. The LLM package owns its six skills;
the top-level `skills/` links preserve existing installation paths. `job_sdks` declares Python
package directories injected into local jobs and included in remote bundles only while enabled.
