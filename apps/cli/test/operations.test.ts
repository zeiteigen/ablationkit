/**
 * Operations commands (ADR 0025): `backup verify|export|restore`, `coordinator move` and
 * `system status`, against a real coordinator with MLflow disabled.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectMappings } from "../src/commands/tracking.ts";
import { main } from "../src/main.ts";
import { Harness, io } from "./helpers.ts";

const h = new Harness();
afterEach(h.cleanup);
const tmp = () => h.tmp("ak-ops-");

describe("operations commands", () => {
  test("backup verify and export, coordinator move, backup restore into a new home, system status", async () => {
    const home = tmp();
    const c = await h.start(home);
    const repo = join(tmp(), "lab");
    mkdirSync(join(repo, ".git"), { recursive: true });
    expect(await main(["project", "add", repo], io(home).ctx)).toBe(0);

    const created = io(home);
    expect(await main(["backup", "create", "--json"], created.ctx)).toBe(0);
    const id = JSON.parse(created.o.stdout).backup_id as string;
    const v = io(home);
    expect(await main(["backup", "verify", id], v.ctx)).toBe(0);
    expect(v.o.stdout).toContain("every file matches");
    const archive = join(tmp(), "b.tar.gz");
    const ex = io(home);
    expect(await main(["backup", "export", id, "--out", archive], ex.ctx)).toBe(0);
    expect(existsSync(archive)).toBe(true);

    const st = io(home);
    expect(await main(["system", "status"], st.ctx)).toBe(0);
    expect(st.o.stdout).toContain("unreadable records: every record loaded");
    expect(st.o.stdout).toContain("artifact store: not configured");

    // An offline restore refuses a running coordinator's home; move refuses a running coordinator.
    const busy = io(home);
    expect(await main(["backup", "restore", id, "--force"], busy.ctx)).toBe(2);
    expect(busy.o.stderr).toContain("stop it first");
    const mv1 = io(home);
    expect(await main(["coordinator", "move", "--out", join(tmp(), "m.tar.gz")], mv1.ctx)).toBe(2);
    expect(mv1.o.stderr).toContain("stop it first");

    await c.stop();
    const out = join(tmp(), "move.tar.gz");
    const mv = io(home);
    expect(await main(["coordinator", "move", "--out", out], mv.ctx)).toBe(0);
    expect(mv.o.stdout).toContain("this home is now retired");
    expect(existsSync(join(home, "moved.json"))).toBe(true);

    // The new machine: another home, the checkout somewhere else.
    const homeB = tmp();
    const clone = join(tmp(), "lab-clone");
    mkdirSync(join(clone, ".git"), { recursive: true });
    const rs = io(homeB);
    expect(
      await main(
        [
          "backup",
          "restore",
          out,
          "--project",
          `lab=${clone}`,
          "--worker-url",
          "http://100.64.0.7:7422",
        ],
        rs.ctx,
      ),
    ).toBe(0);
    expect(rs.o.stdout).toContain(`lab: ${clone} (present`);
    expect(rs.o.stdout).toContain("remote.worker_url: (unset) -> http://100.64.0.7:7422");
    expect(JSON.parse(readFileSync(join(homeB, "registry.json"), "utf8")).projects[0].path).toBe(
      clone,
    );
    const again = io(homeB);
    expect(await main(["backup", "restore", out], again.ctx)).toBe(2);
    expect(again.o.stderr).toContain("already holds coordinator data");
  });

  test("--project may repeat and needs ID=PATH", () => {
    expect(projectMappings(["x", "--project", "a=/p/a", "--project=b=/p/b=c"])).toEqual({
      a: "/p/a",
      b: "/p/b=c",
    });
    expect(() => projectMappings(["--project", "nopath"])).toThrow(/ID=PATH/);
  });
});
