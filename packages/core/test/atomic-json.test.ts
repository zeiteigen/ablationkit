import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileValidator, validateProjectManifest } from "@ablationkit/protocol";
import { Type } from "@sinclair/typebox";
import {
  backupPath,
  diagnoseStorage,
  JsonReadError,
  readJson,
  recoverJsonFile,
  strayTempFiles,
  writeJsonAtomic,
} from "../src/index.ts";
import { crashChild, tempDir } from "./helpers.ts";

const Doc = Type.Object(
  { schema_version: Type.Literal(1), value: Type.String() },
  { additionalProperties: false },
);
const validateDoc = compileValidator(Doc);

describe("writeJsonAtomic", () => {
  test("writes pretty JSON with a trailing newline, private mode, and keeps a backup", () => {
    const path = join(tempDir(), "run.json");
    writeJsonAtomic(path, { schema_version: 1, value: "a" });
    expect(readFileSync(path, "utf8")).toBe('{\n  "schema_version": 1,\n  "value": "a"\n}\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(backupPath(path))).toBe(false);

    writeJsonAtomic(path, { schema_version: 1, value: "b" });
    expect(readJson(path, validateDoc).value).toBe("b");
    expect(readJson(backupPath(path), validateDoc).value).toBe("a");
    expect(readdirSync(join(path, "..")).sort()).toEqual(["run.json", "run.json.bak"]);
  });

  test("an invalid value never touches disk", () => {
    const path = join(tempDir(), "project.json");
    writeJsonAtomic(path, { schema_version: 1, project_id: "lab", name: "Lab" });
    const bad = { schema_version: 1, project_id: "Not A Slug", name: "Lab" };
    expect(() => writeJsonAtomic(path, bad, { validate: validateProjectManifest })).toThrow();
    expect(readJson(path, validateProjectManifest).project_id).toBe("lab");
    expect(strayTempFiles(path)).toEqual([]);
  });

  test("readJson distinguishes missing, unparseable and invalid files", () => {
    const dir = tempDir();
    const kind = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof JsonReadError ? e.kind : "other";
      }
      return "none";
    };
    writeFileSync(join(dir, "parse.json"), "{");
    writeFileSync(join(dir, "invalid.json"), '{"schema_version": 2, "value": "x"}');
    expect(kind(() => readJson(join(dir, "nope.json")))).toBe("missing");
    expect(kind(() => readJson(join(dir, "parse.json")))).toBe("parse");
    expect(kind(() => readJson(join(dir, "invalid.json"), validateDoc))).toBe("invalid");
  });
});

describe("crash during replace (real SIGKILL in a child process)", () => {
  const cases = [
    { step: "temp-written", torn: false, survivor: "old" },
    { step: "temp-written", torn: true, survivor: "old" },
    { step: "backup-linked", torn: false, survivor: "old" },
    { step: "replaced", torn: false, survivor: "new" },
  ] as const;

  test.each(cases)("killed at $step (torn temp: $torn) → $survivor value survives", (c) => {
    const path = join(tempDir(), "run.json");
    crashChild("json", path, c.step, ...(c.torn ? ["torn"] : []));

    // The target itself is never partial: it is the old or the new complete document.
    expect(readJson(path, validateDoc).value).toBe(c.survivor);
    const findings = diagnoseStorage(join(path, ".."));
    const interrupted = findings.filter((f) => f.kind === "interrupted_json_write");
    expect(interrupted.length).toBe(c.step === "replaced" ? 0 : 1);

    const report = recoverJsonFile(path, { validate: validateDoc });
    expect(report.status).toBe("ok");
    expect(report.actions.map((a) => a.kind)).toEqual(interrupted.map(() => "removed_temp"));
    expect(strayTempFiles(path)).toEqual([]);
    expect(diagnoseStorage(join(path, ".."))).toEqual([]);
    expect(readJson(path, validateDoc).value).toBe(c.survivor);

    // And the file is writable again afterwards.
    writeJsonAtomic(path, { schema_version: 1, value: "after" }, { validate: validateDoc });
    expect(readJson(path, validateDoc).value).toBe("after");
  });
});

describe("recoverJsonFile with a damaged target", () => {
  const now = new Date("2026-11-02T10:00:00.000Z");

  test("quarantines a corrupt target and restores the backup", () => {
    const path = join(tempDir(), "run.json");
    writeJsonAtomic(path, { schema_version: 1, value: "a" });
    writeJsonAtomic(path, { schema_version: 1, value: "b" });
    writeFileSync(path, '{"schema_version": 1, "val'); // torn by something outside our protocol

    const report = recoverJsonFile(path, { validate: validateDoc, now });
    expect(report.status).toBe("restored");
    expect(report.actions.map((a) => a.kind)).toEqual(["quarantined", "restored_backup"]);
    expect(readJson(path, validateDoc).value).toBe("a");
    const q = `${path}.quarantine-20261102T100000.000Z`;
    expect(readFileSync(q, "utf8")).toBe('{"schema_version": 1, "val');
    expect(diagnoseStorage(join(path, "..")).map((f) => f.kind)).toEqual(["quarantined_file"]);
  });

  test("a schema-invalid target is treated like a corrupt one", () => {
    const path = join(tempDir(), "run.json");
    writeJsonAtomic(path, { schema_version: 1, value: "a" });
    writeJsonAtomic(path, { schema_version: 1, value: "b" });
    writeFileSync(path, '{"schema_version": 1}');
    expect(recoverJsonFile(path, { validate: validateDoc, now }).status).toBe("restored");
    expect(readJson(path, validateDoc).value).toBe("a");
  });

  test("restores a missing target from its backup", () => {
    const dir = tempDir();
    const path = join(dir, "run.json");
    writeFileSync(backupPath(path), '{"schema_version": 1, "value": "a"}\n');
    const report = recoverJsonFile(path, { validate: validateDoc, now });
    expect(report.status).toBe("restored");
    expect(report.actions.map((a) => a.kind)).toEqual(["restored_backup"]);
  });

  test("leaves everything in place when no valid copy exists", () => {
    const path = join(tempDir(), "run.json");
    writeFileSync(path, "garbage");
    const report = recoverJsonFile(path, { validate: validateDoc, now });
    expect(report.status).toBe("unrecoverable");
    expect(report.error).toContain("parse");
    expect(readFileSync(path, "utf8")).toBe("garbage");
  });
});
