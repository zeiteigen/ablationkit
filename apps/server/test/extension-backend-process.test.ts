import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKEND_MAX_LINE_BYTES } from "../src/extensions/backend-codec.ts";
import {
  ExtensionBackendProcess,
  type ExtensionBackendProcessOptions,
} from "../src/extensions/backend-process.ts";

const processes: ExtensionBackendProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(processes.splice(0).map((backend) => backend.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function start(source: string, options: Partial<ExtensionBackendProcessOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ak-backend-"));
  directories.push(directory);
  const entry = join(directory, "backend.ts");
  await writeFile(entry, source);
  const backend = new ExtensionBackendProcess({ entry, broker: () => null, ...options });
  processes.push(backend);
  return { backend, directory };
}

describe("trusted extension subprocess transport", () => {
  test("waits for factory readiness, preserves context, scrubs environment and redirects logs", async () => {
    process.env["AK_BACKEND_TEST_SECRET"] = "must-not-leak";
    try {
      const { backend } = await start(
        `
        console.log("module log");
        export default async (context) => {
          await Bun.sleep(20);
          return { call: () => ({
            context: context.extensionId,
            secret: process.env.AK_BACKEND_TEST_SECRET ?? null,
            explicit: process.env.AK_BACKEND_EXPLICIT,
            marker: process.env.ABLATIONKIT_EXTENSION_BACKEND,
          }) };
        };
      `,
        { context: { extensionId: "example" }, env: { AK_BACKEND_EXPLICIT: "yes" } },
      );
      expect(await backend.call("inspect")).toEqual({
        context: "example",
        secret: null,
        explicit: "yes",
        marker: "1",
      });
    } finally {
      delete process.env["AK_BACKEND_TEST_SECRET"];
    }
  });

  test("correlates concurrent backend and host broker calls and delivers notifications", async () => {
    const notifications: unknown[] = [];
    const { backend } = await start(
      `
      export default ({ call, notify }) => ({
        async call(method, params) {
          await Bun.sleep(params.delay);
          const result = await call("double", params.value);
          await notify("done", result);
          return result;
        }
      });
    `,
      {
        broker: async (method, params) => {
          expect(method).toBe("double");
          await Bun.sleep(Number(params) === 1 ? 20 : 1);
          return Number(params) * 2;
        },
        notify: (_method, params) => {
          notifications.push(params);
        },
      },
    );
    expect(
      await Promise.all([
        backend.call("work", { delay: 15, value: 1 }),
        backend.call("work", { delay: 1, value: 2 }),
      ]),
    ).toEqual([2, 4]);
    expect(notifications).toEqual([4, 2]);
  });

  test("void host broker results keep a response envelope and leave the process usable", async () => {
    let calls = 0;
    const { backend } = await start(
      `
      export default ({ call }) => ({
        async call(method) {
          if (method === "void") return await call("host.void");
          return "still running";
        }
      });
    `,
      {
        broker: () => {
          calls++;
          return undefined;
        },
      },
    );
    expect(await backend.call("void")).toBeNull();
    expect(calls).toBe(1);
    expect(await backend.call("echo")).toBe("still running");
  });

  test("round trips nested binary, Response and errors with status/code", async () => {
    const { backend } = await start(
      `
      export default ({ call }) => ({
        async call(method, params) {
          if (method === "fail") throw Object.assign(new Error("backend denied"), { status: 403, code: "DENIED" });
          if (method === "broker") return await call("fail", params);
          if (method === "response") return { response: new Response(new Uint8Array([0, 255, 13]), { status: 201, headers: { "x-result": "yes" } }) };
          return params;
        }
      });
    `,
      {
        broker: () => {
          throw Object.assign(new Error("host denied"), { status: 401, code: "HOST" });
        },
      },
    );
    expect(await backend.call("echo", { bytes: new Uint8Array([0, 255]) })).toEqual({
      bytes: new Uint8Array([0, 255]),
    });
    const result = await backend.call<{ response: Response }>("response");
    expect(result.response.status).toBe(201);
    expect(result.response.headers.get("x-result")).toBe("yes");
    expect(new Uint8Array(await result.response.arrayBuffer())).toEqual(
      new Uint8Array([0, 255, 13]),
    );
    const input = new Response("host response", { status: 202 });
    const echoed = await backend.call<Response>("echo", input);
    expect(echoed.status).toBe(202);
    expect(await echoed.text()).toBe("host response");
    await expect(backend.call("fail")).rejects.toMatchObject({
      message: "backend denied",
      status: 403,
      code: "DENIED",
    });
    await expect(backend.call("broker")).rejects.toMatchObject({
      message: "host denied",
      status: 401,
      code: "HOST",
    });
    expect(await backend.call("echo", "still running")).toBe("still running");
  });

  test("cancels a request with its signal and keeps the process usable", async () => {
    const started = Promise.withResolvers<void>();
    const { backend } = await start(
      `
      let aborted = false;
      export default ({ notify }) => ({
        async call(method, params, { signal }) {
          if (method === "wait") {
            await notify("waiting");
            await new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(null); }, { once: true }));
            return "cancelled";
          }
          return aborted;
        }
      });
    `,
      { notify: () => started.resolve() },
    );
    await backend.ready();
    const controller = new AbortController();
    const request = backend.call("wait", null, { signal: controller.signal });
    await started.promise;
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(await backend.call("aborted")).toBe(true);
    await expect(backend.call("wait", null, { signal: AbortSignal.abort() })).rejects.toMatchObject(
      { name: "AbortError" },
    );
  });

  test("rejects all pending calls after process exit and never restarts", async () => {
    const { backend } = await start(`
      export default () => ({ async call(method) {
        if (method === "exit") process.exit(7);
        await new Promise(() => {});
      } });
    `);
    await backend.ready();
    const waiting = backend.call("wait");
    const exiting = backend.call("exit");
    const results = await Promise.allSettled([waiting, exiting]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await expect(backend.call("again")).rejects.toThrow("exited (7)");
  });

  test("terminates on timeout without replaying a request", async () => {
    const { backend } = await start(
      `export default () => ({ call: () => new Promise(() => {}) });`,
      { timeoutMs: 150 },
    );
    await backend.ready();
    await expect(backend.call("hang")).rejects.toThrow("timed out");
    await expect(backend.call("again")).rejects.toThrow("timed out");
  });

  test("aborts while waiting for factory readiness", async () => {
    const { backend } = await start(`export default async () => {
      await Bun.sleep(200);
      return { call: () => "ready" };
    };`);
    const controller = new AbortController();
    const request = backend.call("wait", null, { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(await backend.call("after")).toBe("ready");
  });

  test("rejects startup factory errors", async () => {
    const { backend } = await start(`export default () => { throw new Error("bad factory"); };`);
    await expect(backend.call("anything")).rejects.toThrow("bad factory");
  });

  test("runs shutdown and aborts the lifecycle signal; close is idempotent", async () => {
    const { backend, directory } = await start(`
      export default ({ signal }) => {
        let marker;
        return {
          call: (_method, params) => { marker = params; },
          async shutdown() { await Bun.write(marker, String(signal.aborted)); }
        };
      };
    `);
    const marker = join(directory, "shutdown.txt");
    await backend.call("setPath", marker);
    const closing = backend.close();
    expect(backend.close()).toBe(closing);
    await closing;
    expect(await readFile(marker, "utf8")).toBe("true");
    await expect(backend.call("anything")).rejects.toThrow("closing");
  });

  test("bounds shutdown when a factory or shutdown handler hangs", async () => {
    const { backend } = await start(
      `export default () => ({ call: () => null, shutdown: () => new Promise(() => {}) });`,
    );
    await backend.ready();
    const before = Date.now();
    await backend.close();
    expect(Date.now() - before).toBeLessThan(3_500);
  });

  test("terminates on malformed child output and oversized request lines", async () => {
    const { backend } = await start(
      `export default () => ({ call() { process.stdout.write("not-json\\n"); return null; } });`,
    );
    await expect(backend.call("bad")).rejects.toThrow();
    const { backend: oversized } = await start(
      `export default () => ({ call: (_method, params) => params });`,
    );
    await expect(oversized.call("big", "x".repeat(BACKEND_MAX_LINE_BYTES))).rejects.toThrow(
      "exceeds 16 MiB",
    );
  });
});
