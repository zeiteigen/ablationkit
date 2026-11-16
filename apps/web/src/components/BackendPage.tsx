/** Trusted host for a builtin backend page running in a sandboxed iframe. */
import { useEffect, useMemo, useRef } from "react";
import { api, type CoordinatorEvent, useApi, useEvents } from "../api.ts";
import type { BackendPageDeclaration, RegisteredBackend } from "../nav.ts";
import { navigate } from "../router.ts";
import { ErrorBox, Loading, TrailLeaf } from "./ui.tsx";

type Subscription = { project?: string; types?: string[] };
type Context = { pid: string; base: string; rest: string };

function resolveBackendPage(
  rest: string,
  backends: readonly RegisteredBackend[],
): { backend: RegisteredBackend; page: BackendPageDeclaration; rest: string } | undefined {
  const path = rest || "/";
  const matches = backends.flatMap((backend) =>
    backend.pages.flatMap((page) => {
      const prefix = page.path.replace(/\/+$/, "") || "/";
      if (path !== prefix && !path.startsWith(`${prefix === "/" ? "" : prefix}/`)) return [];
      return [{ backend, page, rest: path === prefix ? "" : path.slice(prefix.length) }];
    }),
  );
  return matches.sort((a, b) => b.page.path.length - a.page.path.length)[0];
}

/** Resolves a project path against the coordinator's declared backend pages. */
export function BackendProjectPage(props: { pid: string; base: string; rest: string }) {
  const path = `/api/v1/projects/${encodeURIComponent(props.pid)}/extension-backends`;
  const d = useApi<{ extensions: RegisteredBackend[] }>(path);
  useEvents(() => d.reload(), {
    project: props.pid,
    types: ["extension.backend.activation"],
  });
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const match = resolveBackendPage(props.rest, d.data.extensions ?? []);
  if (!match) return <ErrorBox error={new Error(`No backend page at ${props.rest}`)} />;
  if (!match.backend.enabled)
    return <ErrorBox error={new Error(`${match.page.title} is disabled for this project`)} />;
  return (
    <>
      <TrailLeaf>{match.page.title}</TrailLeaf>
      <BackendPage
        pid={props.pid}
        extensionId={match.backend.id}
        pageId={match.page.id}
        title={match.page.title}
        canSubscribe={match.backend.capabilities?.includes("events.subscribe") === true}
        {...(match.backend.bundled && match.page.api_path !== undefined
          ? { apiPrefix: match.page.api_path }
          : {})}
        base={props.base}
        rest={match.rest}
      />
    </>
  );
}

function BackendPage(props: {
  pid: string;
  extensionId: string;
  pageId: string;
  title: string;
  canSubscribe?: boolean;
  apiPrefix?: string;
  base: string;
  rest: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const subscriptions = useRef(new Map<number, Subscription>());
  const context = useMemo<Context>(
    () => ({ pid: props.pid, base: props.base, rest: props.rest }),
    [props.pid, props.base, props.rest],
  );

  const contextRef = useRef(context);
  contextRef.current = context;

  useEvents((event: CoordinatorEvent) => {
    if (event.project_id !== props.pid) return;
    for (const filter of subscriptions.current.values()) {
      if (filter.project && event.project_id && filter.project !== event.project_id) continue;
      if (filter.types?.length && !filter.types.includes(event.type)) continue;
      portRef.current?.postMessage({ type: "event", event });
      break;
    }
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: remount only when the page identity changes
  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    const onHello = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || event.data?.type !== "ablationkit.backend.hello")
        return;
      portRef.current?.close();
      const channel = new MessageChannel();
      portRef.current = channel.port1;
      channel.port1.onmessage = async ({ data }: MessageEvent) => {
        if (typeof data?.id !== "number" || typeof data.method !== "string") return;
        const id = data.id;
        const reply = (
          result?: unknown,
          error?: { status?: number; code: string; message: string },
        ) => channel.port1.postMessage(error ? { id, error } : { id, result });
        const params = (data.params ?? {}) as Record<string, unknown>;
        try {
          if (data.method === "request") {
            const path = String(params["path"] ?? "");
            const init = (params["init"] ?? {}) as {
              method?: string;
              body?: unknown;
            };
            const projectPrefix = `/api/v1/projects/${encodeURIComponent(props.pid)}`;
            const declaredApiPath = props.apiPrefix;
            const safeApiPath =
              declaredApiPath?.startsWith("/") &&
              !declaredApiPath.startsWith("//") &&
              !/[?#\\]/.test(declaredApiPath) &&
              !declaredApiPath.split("/").some((part) => part === "." || part === "..");
            const apiPrefix = props.apiPrefix
              ? safeApiPath
                ? `${projectPrefix}${props.apiPrefix}`
                : ""
              : `${projectPrefix}/extensions/${encodeURIComponent(props.extensionId)}/operations`;
            const normalized = new URL(path, location.origin);
            const allowedPath = (prefix: string) =>
              Boolean(prefix) &&
              (normalized.pathname === prefix || normalized.pathname.startsWith(`${prefix}/`));
            const validPath =
              normalized.origin === location.origin &&
              path.startsWith("/") &&
              allowedPath(apiPrefix);
            if (!validPath) {
              reply(undefined, {
                status: 403,
                code: "path_not_allowed",
                message: "Backend page request path is not allowed",
              });
              return;
            }
            reply(
              await api(path, {
                ...(init.method !== undefined ? { method: init.method } : {}),
                ...(init.body !== undefined ? { body: init.body } : {}),
              }),
            );
          } else if (data.method === "navigate") {
            const to = String(params["path"] ?? "");
            if (!to.startsWith(`/p/${encodeURIComponent(props.pid)}/`)) {
              reply(undefined, {
                status: 403,
                code: "path_not_allowed",
                message: "Navigation is outside this project",
              });
              return;
            }
            navigate(to);
            reply(null);
          } else if (data.method === "subscribe") {
            if (
              !props.canSubscribe ||
              (params["project"] !== undefined && params["project"] !== props.pid)
            ) {
              reply(undefined, {
                status: 403,
                code: "capability_denied",
                message: "Event subscription is not allowed",
              });
              return;
            }
            const subscriptionId = Number(params["subscription_id"]);
            if (!Number.isSafeInteger(subscriptionId)) {
              reply(undefined, {
                status: 400,
                code: "invalid_request",
                message: "Subscription id is invalid",
              });
              return;
            }
            if (params["active"] === false) subscriptions.current.delete(subscriptionId);
            else
              subscriptions.current.set(subscriptionId, {
                ...(typeof params["project"] === "string" ? { project: params["project"] } : {}),
                ...(Array.isArray(params["types"])
                  ? { types: params["types"].filter((v): v is string => typeof v === "string") }
                  : {}),
              });
            reply(null);
          } else
            reply(undefined, {
              status: 403,
              code: "method_not_allowed",
              message: "Backend page method is not allowed",
            });
        } catch (error) {
          const e = error as { status?: number; code?: string; message?: string };
          reply(undefined, {
            status: e.status ?? 500,
            code: e.code ?? "host_error",
            message: e.message ?? String(error),
          });
        }
      };
      channel.port1.start();
      iframe.contentWindow?.postMessage(
        { type: "ablationkit.backend.connect", context: contextRef.current },
        "*",
        [channel.port2],
      );
    };
    window.addEventListener("message", onHello);
    return () => {
      window.removeEventListener("message", onHello);
      portRef.current?.close();
      portRef.current = null;
      subscriptions.current.clear();
    };
  }, [props.pid, props.extensionId, props.pageId, props.canSubscribe]);

  useEffect(() => {
    portRef.current?.postMessage({ type: "context", context });
  }, [context]);

  return (
    <iframe
      ref={frame}
      title={props.title}
      src={`/api/v1/projects/${encodeURIComponent(props.pid)}/extensions/${encodeURIComponent(props.extensionId)}/backend/pages/${encodeURIComponent(props.pageId)}`}
      sandbox="allow-scripts"
      style={{ display: "block", width: "100%", height: 900, border: 0 }}
    />
  );
}
