/** Generic MCP backend operation exposure against a small HTTP coordinator contract fixture. */
import { afterEach, describe, expect, test } from "bun:test";
import { agentApi, handleMcp, MCP_TOOLS, OPERATIONS } from "../src/commands/mcp.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
const registry = {
  extensions: [
    {
      id: "fixture",
      version: "1.0.0",
      enabled: true,
      operations: [{ id: "fixture.echo", method: "POST", path: "/echo/:item", agent: true }],
      pages: [{ id: "main", title: "Fixture view", path: "/fixture", entry: "view.js" }],
    },
  ],
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function fixture() {
  const requests: { method: string; path: string; body?: unknown; authorization: string | null }[] =
    [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body: unknown = request.method === "POST" ? await request.json() : undefined;
      requests.push({
        method: request.method,
        path,
        ...(body === undefined ? {} : { body }),
        authorization: request.headers.get("authorization"),
      });
      if (path === "/api/v1/projects/project/extension-backends") return Response.json(registry);
      if (path === "/api/v1/projects/project/extensions/fixture/operations/fixture.denied")
        return Response.json(
          { error: { code: "human_only", message: "Researcher only" } },
          { status: 403 },
        );
      if (path.startsWith("/api/v1/projects/project/extensions/") && path.includes("/operations/"))
        return Response.json({ received: body, status: "called" });
      return Response.json(
        { error: { code: "not_found", message: "Unknown test route" } },
        { status: 404 },
      );
    },
  });
  servers.push(server);
  const api = agentApi(`http://127.0.0.1:${server.port}`, "fixture-agent", "project");
  const session = { harness: "test", start: async () => ({}), api: async () => api };
  const mcp = (name: string, args: Record<string, unknown> = {}) =>
    handleMcp({ id: 1, method: "tools/call", params: { name, arguments: args } }, session);
  return { requests, mcp };
}

describe("extension backend MCP", () => {
  test("advertises generic discovery and call operations with explicit JSON envelope schemas", async () => {
    const ops = OPERATIONS.filter((o) => ["extension.operations", "extension.call"].includes(o.id));
    expect(ops).toHaveLength(2);
    const call = ops.find((o) => o.id === "extension.call");
    expect(call?.inputSchema).toMatchObject({
      type: "object",
      required: ["extension_id", "operation"],
      properties: {
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            params: { type: "object" },
            body: { type: "object" },
            path: { type: "string" },
          },
        },
      },
    });
    expect(OPERATIONS.some((o) => /extension\.(enable|approve|activate)/.test(o.id))).toBe(false);
    expect(MCP_TOOLS.map((t) => t.name)).toContain("ablationkit_do");
  });

  test("discovery and calls use the token-bound project and preserve JSON input", async () => {
    const { mcp, requests } = fixture();
    const listed = await mcp("ablationkit_read", { op: "extension.operations" });
    expect(listed?.["result"]).toMatchObject({ structuredContent: registry });
    const input = { params: { item: "one" }, body: { count: 2 }, path: "/echo/one" };
    const called = await mcp("ablationkit_do", {
      op: "extension.call",
      extension_id: "fixture",
      operation: "fixture.echo",
      input,
    });
    expect(called?.["result"]).toMatchObject({
      structuredContent: { received: input, status: "called" },
    });
    expect(requests[1]).toMatchObject({
      method: "POST",
      path: "/api/v1/projects/project/extensions/fixture/operations/fixture.echo",
      body: input,
      authorization: "Bearer fixture-agent",
    });
    expect(
      (
        await mcp("ablationkit_do", {
          op: "extension.call",
          extension_id: "fixture",
          operation: "fixture.echo",
        })
      )?.["result"],
    ).toMatchObject({ structuredContent: { received: {} } });
  });

  test("surfaces host agent restrictions and rejects malformed invocation arguments", async () => {
    const { mcp, requests } = fixture();
    const denied = await mcp("ablationkit_do", {
      op: "extension.call",
      extension_id: "fixture",
      operation: "fixture.denied",
    });
    expect(denied?.["result"]).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "human_only: Researcher only (HTTP 403)" }],
      structuredContent: { error: { code: "human_only", message: "Researcher only", status: 403 } },
    });
    for (const args of [
      { operation: "fixture.echo" },
      { extension_id: "fixture" },
      { extension_id: "fixture", operation: "fixture.echo", input: [] },
      { extension_id: "fixture", operation: "fixture.echo", input: null },
    ]) {
      expect(
        (await mcp("ablationkit_do", { op: "extension.call", ...args }))?.["result"],
      ).toMatchObject({
        isError: true,
      });
    }
    expect(requests).toHaveLength(1);
  });
});
