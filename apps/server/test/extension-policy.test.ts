import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionDestination,
  type ExtensionPolicyOptions,
  type ExtensionPolicyRules,
  ExtensionPolicyStore,
} from "../src/extensions/policy.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const localDestination: ExtensionDestination = {
  id: "local",
  base_url: "http://127.0.0.1:9000/v1",
  allow_external: false,
  allow_dataset: false,
};
const localRules: ExtensionPolicyRules = { destinations: [localDestination] };

async function store(options: Omit<ExtensionPolicyOptions, "stateDir"> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "ak-ext-policy-"));
  directories.push(stateDir);
  return { stateDir, policy: new ExtensionPolicyStore({ stateDir, ...options }) };
}

function fakeFetch(
  handler: (input: URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: unknown, init: RequestInit) =>
    handler(new URL(String(input)), init)) as typeof fetch;
}

function update(policy: ExtensionPolicyStore, rules: ExtensionPolicyRules, allowWiden = false) {
  return policy.update("project", "extension", rules, {
    expected_revision: policy.get("project", "extension").revision,
    allowWiden,
  });
}

describe("extension network policy", () => {
  test("persists independent grants with revision CAS and no dependency on backend activation", async () => {
    const { policy, stateDir } = await store();
    expect(policy.get("project", "extension")).toEqual({ revision: 0, destinations: [] });
    const first = update(policy, localRules);
    expect(first.revision).toBe(1);
    const recreated = new ExtensionPolicyStore({ stateDir });
    expect(recreated.get("project", "extension")).toEqual(first);
    expect(recreated.get("project", "different")).toEqual({ revision: 0, destinations: [] });
    expect(() =>
      policy.update("project", "extension", localRules, { expected_revision: 0, allowWiden: true }),
    ).toThrow("revision 1");
    expect(() =>
      policy.update("project", "extension", localRules, {
        expected_revision: null,
        allowWiden: true,
      }),
    ).toThrow("revision 1");
    expect(update(recreated, { destinations: [] }).revision).toBe(2);
    expect(policy.get("project", "extension").destinations).toEqual([]);
    expect((await readdir(join(stateDir, "project", "extension-policy"))).sort()).toEqual([
      "extension.json",
      "extension.json.bak",
    ]);
  });

  test("new sensitive destinations and grant widening require explicit authorization", async () => {
    const { policy } = await store();
    update(policy, localRules);
    for (const change of [
      { credential_env: "API_KEY" },
      { id: "external", base_url: "https://example.test/v1", allow_external: true },
      { id: "external", base_url: "https://example.test/v1", allow_dataset: true },
    ]) {
      expect(() => update(policy, { destinations: [{ ...localDestination, ...change }] })).toThrow(
        "widens",
      );
    }
    const approved = update(
      policy,
      { destinations: [{ ...localDestination, allow_dataset: true }] },
      true,
    );
    expect(approved.destinations[0]?.allow_dataset).toBe(true);
    expect(update(policy, localRules).destinations[0]?.allow_dataset).toBe(false);
  });

  test("detects broader model, capture, retention and redaction permissions", async () => {
    const { policy } = await store();
    const initial: ExtensionPolicyRules = {
      destinations: [{ ...localDestination, models: ["allowed"] }],
      capture: {
        mode: "redacted",
        retention_days: 30,
        builtin_redactions: ["email", "secret"],
        redaction_patterns: ["internal"],
        patterns: [{ name: "private", regex: "private.*" }],
        remote_capture: false,
      },
    };
    update(policy, initial, true);
    const capture = initial.capture;
    if (!capture) throw new Error("test capture missing");
    for (const change of [
      { mode: "full" as const },
      { retention_days: 31 },
      { builtin_redactions: ["email"] },
      { redaction_patterns: [] },
      { patterns: [{ name: "private", regex: "changed" }] },
      { remote_capture: true },
    ])
      expect(() => update(policy, { ...initial, capture: { ...capture, ...change } })).toThrow(
        "widens",
      );
    expect(() => update(policy, { ...initial, destinations: [localDestination] })).toThrow(
      "widens",
    );
    expect(() =>
      update(policy, {
        ...initial,
        destinations: [{ ...localDestination, models: ["allowed", "new"] }],
      }),
    ).toThrow("widens");
    expect(
      update(policy, {
        ...initial,
        capture: { ...capture, mode: "metadata_only", retention_days: 7 },
      }).capture?.retention_days,
    ).toBe(7);
  });

  test("allows loopback requests without external approval and enforces external and dataset grants", async () => {
    const seen: string[] = [];
    const { policy } = await store({
      fetch: fakeFetch((url) => {
        seen.push(url.href);
        return new Response("ok");
      }),
    });
    update(policy, localRules);
    expect(
      await (
        await policy.request("project", "extension", {
          destination: "local",
          path: "chat",
          data: "adhoc",
        })
      ).text(),
    ).toBe("ok");
    expect(seen).toEqual(["http://127.0.0.1:9000/v1/chat"]);
    await expect(
      policy.request("project", "extension", {
        destination: "local",
        path: "chat",
        data: "dataset",
      }),
    ).rejects.toMatchObject({ status: 403, code: "dataset_denied" });
    update(
      policy,
      {
        destinations: [
          { ...localDestination, id: "external", base_url: "https://example.test/v1" },
        ],
      },
      true,
    );
    await expect(
      policy.request("project", "extension", {
        destination: "external",
        path: "chat",
        data: "adhoc",
      }),
    ).rejects.toMatchObject({ code: "external_denied" });
    update(
      policy,
      {
        destinations: [
          {
            ...localDestination,
            id: "external",
            base_url: "https://example.test/v1",
            allow_external: true,
            allow_dataset: true,
          },
        ],
      },
      true,
    );
    expect(
      (
        await policy.request("project", "extension", {
          destination: "external",
          path: "chat",
          data: "dataset",
        })
      ).status,
    ).toBe(200);
    await expect(
      policy.request("project", "other", { destination: "external", path: "chat", data: "adhoc" }),
    ).rejects.toMatchObject({ code: "destination_denied" });
  });

  test("rejects cross-origin, prefix escapes and ambiguous encoded paths before fetching", async () => {
    let fetched = 0;
    const { policy } = await store({
      fetch: fakeFetch(() => {
        fetched++;
        return new Response("ok");
      }),
    });
    update(policy, localRules);
    for (const path of [
      "https://evil.test/v1/x",
      "//evil.test/x",
      "/v10/x",
      "../outside",
      "/v1/../../x",
      "\\\\evil.test\\x",
      "%252e%252e/x",
      "x%2fy",
      "x%255cy",
      "chat#fragment",
    ]) {
      await expect(
        policy.request("project", "extension", { destination: "local", path, data: "adhoc" }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(fetched).toBe(0);
    expect(
      (
        await policy.request("project", "extension", {
          destination: "local",
          path: "/v1/chat?q=ok",
          data: "adhoc",
        })
      ).status,
    ).toBe(200);
  });

  test("requires exact allowed models and prevents misleading model labels", async () => {
    const { policy } = await store({ fetch: fakeFetch(() => new Response("ok")) });
    update(policy, { destinations: [{ ...localDestination, models: ["exact"] }] });
    for (const model of [undefined, "exact-extra", "EXACT"]) {
      await expect(
        policy.request("project", "extension", {
          destination: "local",
          path: "chat",
          data: "adhoc",
          ...(model === undefined ? {} : { model }),
        }),
      ).rejects.toMatchObject({ code: "model_denied" });
    }
    await expect(
      policy.request("project", "extension", {
        destination: "local",
        path: "chat",
        data: "adhoc",
        model: "exact",
        body: { model: "forbidden" },
      }),
    ).rejects.toMatchObject({ code: "model_denied" });
    expect(
      (
        await policy.request("project", "extension", {
          destination: "local",
          path: "chat",
          data: "adhoc",
          model: "exact",
          body: { model: "exact" },
        })
      ).status,
    ).toBe(200);
  });

  test("injects host credentials, reports only their availability, and redacts accidental echoes", async () => {
    const secret = "host-only-credential";
    const environment: Record<string, string | undefined> = { SERVICE_KEY: secret };
    const { policy, stateDir } = await store({
      env: () => environment,
      fetch: fakeFetch((_url, init) => {
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${secret}`);
        expect(init.redirect).toBe("error");
        return new Response(`echo ${secret}`, {
          status: 201,
          headers: { "x-upstream": secret, "set-cookie": secret },
        });
      }),
    });
    update(
      policy,
      { destinations: [{ ...localDestination, credential_env: "SERVICE_KEY" }] },
      true,
    );
    expect(policy.hasCredential("SERVICE_KEY")).toBe(true);
    expect(policy.hasCredential("MISSING")).toBe(false);
    expect(policy.hasCredential("../../unsafe")).toBe(false);
    const response = await policy.request("project", "extension", {
      destination: "local",
      path: "chat",
      data: "adhoc",
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("echo [redacted]");
    expect(response.headers.get("x-upstream")).toBe("[redacted]");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(
      await readFile(join(stateDir, "project", "extension-policy", "extension.json"), "utf8"),
    ).not.toContain(secret);
    delete environment["SERVICE_KEY"];
    expect(policy.hasCredential("SERVICE_KEY")).toBe(false);
    await expect(
      policy.request("project", "extension", { destination: "local", path: "chat", data: "adhoc" }),
    ).rejects.toMatchObject({ status: 503, code: "credential_missing" });
  });

  test("blocks caller supplied credentials and sensitive or routing headers", async () => {
    const { policy } = await store({
      fetch: fakeFetch(() => {
        throw new Error("must not fetch");
      }),
    });
    update(policy, localRules);
    for (const name of [
      "Authorization",
      "Proxy-Authorization",
      "Cookie",
      "X-API-Key",
      "X-Access-Token",
      "X-Access-Key",
      "Host",
      "Connection",
      "Content-Length",
      "X-Forwarded-Host",
    ]) {
      await expect(
        policy.request("project", "extension", {
          destination: "local",
          path: "chat",
          data: "adhoc",
          headers: { [name]: "value" },
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  test("rejects redirects even with an injected fetch that returns one", async () => {
    const { policy } = await store({
      fetch: fakeFetch((_url, init) => {
        expect(init.redirect).toBe("error");
        return new Response(null, { status: 302, headers: { location: "https://evil.test" } });
      }),
    });
    update(policy, localRules);
    await expect(
      policy.request("project", "extension", { destination: "local", path: "chat", data: "adhoc" }),
    ).rejects.toMatchObject({ code: "redirect_denied" });
  });

  test("bounds JSON requests and streamed responses without trusting Content-Length", async () => {
    let cancelled = false;
    let fetched = 0;
    const { policy } = await store({
      maxRequestBytes: 32,
      maxResponseBytes: 32,
      fetch: fakeFetch(() => {
        fetched++;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(20));
              controller.enqueue(new Uint8Array(20));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      }),
    });
    update(policy, localRules);
    await expect(
      policy.request("project", "extension", {
        destination: "local",
        path: "chat",
        data: "adhoc",
        body: "x".repeat(32),
      }),
    ).rejects.toMatchObject({ code: "request_too_large" });
    expect(fetched).toBe(0);
    await expect(
      policy.request("project", "extension", { destination: "local", path: "chat", data: "adhoc" }),
    ).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancelled).toBe(true);
  });

  test("preserves binary response bytes and metadata", async () => {
    const { policy } = await store({
      fetch: fakeFetch(
        () =>
          new Response(new Uint8Array([0, 255, 128]), {
            status: 202,
            headers: { "content-type": "application/octet-stream", "x-result": "yes" },
          }),
      ),
    });
    update(policy, localRules);
    const response = await policy.request("project", "extension", {
      destination: "local",
      path: "binary",
      data: "adhoc",
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-result")).toBe("yes");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]));
  });

  test("bounds a stalled response and honors caller cancellation without leaking fetch errors", async () => {
    const { policy } = await store({
      timeoutMs: 30,
      fetch: fakeFetch(
        () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })),
      ),
    });
    update(policy, localRules);
    await expect(
      policy.request("project", "extension", { destination: "local", path: "hang", data: "adhoc" }),
    ).rejects.toMatchObject({ code: "network_timeout" });
    const controller = new AbortController();
    const request = policy.request("project", "extension", {
      destination: "local",
      path: "cancel",
      data: "adhoc",
      signal: controller.signal,
    });
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "request_canceled" });
    const { policy: failing } = await store({
      fetch: fakeFetch(() => {
        throw new Error("upstream echoed secret");
      }),
    });
    update(failing, localRules);
    await expect(
      failing.request("project", "extension", {
        destination: "local",
        path: "error",
        data: "adhoc",
      }),
    ).rejects.toMatchObject({
      code: "network_error",
      message: "Extension destination request failed",
    });
  });

  test("rejects invalid identifiers, URLs and policy shapes", async () => {
    const { policy } = await store();
    expect(() => policy.get("..", "extension")).toThrow("identifier");
    expect(() => policy.get("project", "../extension")).toThrow("identifier");
    for (const base_url of [
      "file:///tmp/file",
      "https://user:key@example.test",
      "https://example.test?query",
      "https://example.test#fragment",
    ]) {
      expect(() =>
        update(policy, { destinations: [{ ...localDestination, base_url }] }, true),
      ).toThrow("HTTP URL");
    }
    expect(() => update(policy, { destinations: [localDestination, localDestination] })).toThrow(
      "Duplicate",
    );
    expect(policy.get("project", "extension").revision).toBe(0);
  });
  test("metadata probes carry no project bodies and only use declared GET paths", async () => {
    let requests = 0;
    const { policy } = await store({
      fetch: fakeFetch((_url, init) => {
        requests++;
        expect(init.body).toBeUndefined();
        return Response.json({ data: [] });
      }),
    });
    update(policy, {
      destinations: [
        {
          id: "external",
          base_url: "https://example.test/v1",
          models: ["allowed"],
          metadata_paths: ["models"],
          allow_external: false,
          allow_dataset: false,
        },
      ],
    });
    const input = {
      destination: "external",
      path: "models",
      method: "GET",
      data: "metadata" as const,
    };
    expect((await policy.request("project", "extension", input)).status).toBe(200);
    for (const patch of [
      { body: { secret: "body" } },
      { method: "POST" },
      { path: "chat/completions" },
      { headers: { "x-project": "secret" } },
    ])
      await expect(
        policy.request("project", "extension", { ...input, ...patch }),
      ).rejects.toMatchObject({ status: 400 });
    expect(requests).toBe(1);
    update(
      policy,
      {
        destinations: [
          {
            ...(policy.get("project", "extension").destinations[0] as ExtensionDestination),
            credential_env: "API_KEY",
          },
        ],
      },
      true,
    );
    await expect(policy.request("project", "extension", input)).rejects.toMatchObject({
      status: 403,
      code: "external_denied",
    });
  });
});
