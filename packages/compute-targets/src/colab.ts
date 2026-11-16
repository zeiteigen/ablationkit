/**
 * Google Colab notebooks (`colab.mode: notebook`, the default; spec §10: export notebooks; never
 * promise unattended execution or permanent connectivity; isolated runtimes spool output and
 * support later collection; ADR 0023). Unattended runtimes through Google's Colab CLI are
 * `colab-cli.ts` (ADR 0059).
 *
 * `stage` writes `notebook.ipynb` next to the bundle. The notebook carries the bundle (base64, with
 * its SHA-256), runs `ablationkit_worker run` in the Colab runtime, and archives the worker's
 * `state.json` and `spool/` for `ablationkit remote import`. By default it carries no credentials:
 * the worker cannot reach the coordinator, spools everything and stops after the job. With
 * `colab.live` it carries the attempt's tokens and delivers live when `worker_url` is reachable.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ComputeTarget } from "@ablationkit/protocol";
import type {
  Capabilities,
  DoctorCheck,
  ProviderStatus,
  StageInput,
  TargetAdapter,
} from "./targets.ts";
import { TargetError } from "./targets.ts";

const MAX_NOTEBOOK_BUNDLE = 64 * 1024 * 1024;

/** Archives up to this size are also printed as base64 (a download that silently does nothing). */
export const MAX_PRINTED_ARCHIVE = 20 * 1024 * 1024;
const ARCHIVE_BEGIN =
  /-----BEGIN ABLATIONKIT ARCHIVE name=(ak-[A-Za-z0-9_-]{1,128}-state\.tgz) bytes=([0-9]{1,10}) sha256=([0-9a-f]{64})-----/;
const ARCHIVE_END = "-----END ABLATIONKIT ARCHIVE-----";

export interface PrintedArchive {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

/**
 * The archive a notebook printed between its BEGIN/END markers (text copied from Colab's output),
 * checked against the size and SHA-256 on the BEGIN line. Anything else in the text is ignored.
 */
export function parsePrintedArchive(text: string): PrintedArchive {
  const m = ARCHIVE_BEGIN.exec(text);
  if (!m)
    throw new TargetError(
      "invalid_archive",
      "no `-----BEGIN ABLATIONKIT ARCHIVE …-----` line: copy the notebook's output from BEGIN to END",
    );
  const [, name, size, sha] = m as unknown as [string, string, string, string];
  const start = m.index + m[0].length;
  const end = text.indexOf(ARCHIVE_END, start);
  if (end < 0)
    throw new TargetError(
      "invalid_archive",
      "the archive has no END marker: the copy was cut short (copy through `-----END ABLATIONKIT ARCHIVE-----`)",
    );
  // Copied output may carry line breaks, indentation or a prompt column: keep base64 only.
  const body = text.slice(start, end).replace(/[^A-Za-z0-9+/=]/g, "");
  const bytes = Buffer.from(body, "base64");
  if (bytes.length !== Number(size))
    throw new TargetError(
      "invalid_archive",
      `the archive decodes to ${bytes.length} bytes, not ${size}: part of the text is missing or changed`,
    );
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha)
    throw new TargetError(
      "invalid_archive",
      `the archive's SHA-256 is ${got}, not ${sha}: part of the text is changed`,
    );
  return { name, sha256: sha, bytes: new Uint8Array(bytes) };
}

/** The credentials of a worker that never calls the coordinator (it spools everything). */
export const OFFLINE_CREDENTIALS = `${JSON.stringify({
  schema_version: 1,
  launch_token: "offline",
  launch_expires_at: "2099-01-01T00:00:00.000Z",
  upload_token: "offline",
  upload_expires_at: "2099-01-01T00:00:00.000Z",
})}\n`;

function cell(kind: "markdown" | "code", text: string) {
  const source = text.split("\n").map((l, i, a) => (i < a.length - 1 ? `${l}\n` : l));
  return kind === "markdown"
    ? { cell_type: "markdown", metadata: {}, source }
    : { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source };
}

/** The notebook for one attempt. */
export function colabNotebook(t: ComputeTarget, input: StageInput, bundle: Uint8Array): object {
  const live = t.colab?.live === true;
  const dir = `${t.work_dir ?? "/content/ablationkit"}/${input.attemptId}`;
  const creds = live ? input.credentials : OFFLINE_CREDENTIALS;
  const deadline = live ? (t.colab?.deliver_deadline_sec ?? 120) : 0;
  const b64 = Buffer.from(bundle).toString("base64");
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3" },
      language_info: { name: "python" },
      ablationkit: { attempt_id: input.attemptId, job_id: input.jobId, live },
    },
    cells: [
      cell(
        "markdown",
        [
          `# AblationKit attempt \`${input.attemptId}\``,
          "",
          `Job \`${input.jobId}\`, from a pinned bundle (SHA-256 \`${input.bundleSha256}\`).`,
          "",
          "Run the cells in order and keep this tab open: Colab does **not** run unattended, and an idle or",
          "disconnected runtime can lose the run. AblationKit records this attempt as *exported* until its",
          "results come back.",
          "",
          live
            ? "This notebook holds the attempt's worker credentials: treat it as a secret. It delivers results live while the coordinator is reachable."
            : "This notebook holds **no credentials**. Results are spooled in the runtime; the last cell downloads an archive for `ablationkit remote import`.",
        ].join("\n"),
      ),
      cell(
        "code",
        [
          "# 1. Unpack and verify the bundle (source at the pinned commit, the worker and the SDK).",
          "import base64, hashlib, io, os, tarfile",
          `D = ${JSON.stringify(dir)}`,
          `BUNDLE = ${JSON.stringify(b64)}`,
          "data = base64.b64decode(BUNDLE)",
          `assert hashlib.sha256(data).hexdigest() == ${JSON.stringify(input.bundleSha256)}, "bundle checksum mismatch"`,
          'if not os.path.exists(os.path.join(D, "state.json")):',
          '    os.makedirs(os.path.join(D, "bundle"), exist_ok=True)',
          "    with tarfile.open(fileobj=io.BytesIO(data)) as tf:",
          "        for m in tf.getmembers():",
          '            assert not (m.name.startswith("/") or ".." in m.name.split("/") or m.issym() or m.islnk()), m.name',
          '        tf.extractall(os.path.join(D, "bundle"))',
          `    with open(os.path.join(D, "credentials.json"), "w") as f:`,
          `        f.write(${JSON.stringify(creds)})`,
          '    os.chmod(os.path.join(D, "credentials.json"), 0o600)',
          'print("bundle ready in", D)',
        ].join("\n"),
      ),
      cell(
        "code",
        [
          "# 2. Run the job under the AblationKit worker (it never reruns a job that already ran here).",
          "import subprocess, sys",
          "env = dict(os.environ)",
          'env["PYTHONPATH"] = os.path.join(D, "bundle", "worker")',
          `env["ABLATIONKIT_WORKER_DELIVER_DEADLINE_SEC"] = "${deadline}"`,
          'env.setdefault("ABLATIONKIT_WORKER_SUPERVISOR", "direct")',
          ...(live
            ? []
            : ['env["ABLATIONKIT_WORKER_OFFLINE"] = "1"  # no credentials: spool only']),
          'rc = subprocess.call([sys.executable, "-m", "ablationkit_worker", "run", "--dir", D, "--provider-job-id", "colab"], env=env)',
          'print("worker exit", rc, "(0: delivered; 75: results wait in the spool)")',
          'print(open(os.path.join(D, "spool", "stdout.log")).read()[-4000:] if os.path.exists(os.path.join(D, "spool", "stdout.log")) else "")',
        ].join("\n"),
      ),
      cell(
        "code",
        [
          "# 3. Archive the worker state and spool, then download it. A download can silently do",
          "#    nothing in some browsers, so a small archive is also printed as base64 below.",
          "import hashlib",
          `ARCHIVE = os.path.join(os.path.dirname(D), ${JSON.stringify(`ak-${input.attemptId}-state.tgz`)})`,
          'subprocess.check_call(["tar", "-czf", ARCHIVE, "-C", D, "state.json", "spool"])',
          'print("wrote", ARCHIVE)',
          "try:",
          "    from google.colab import files",
          "    files.download(ARCHIVE)",
          "except ImportError:",
          '    print("not in Colab: copy", ARCHIVE, "to the coordinator machine")',
          "except Exception as e:",
          '    print("the download did not start:", e)',
          "size = os.path.getsize(ARCHIVE)",
          `if size <= ${MAX_PRINTED_ARCHIVE}:`,
          '    raw = open(ARCHIVE, "rb").read()',
          "    b = base64.b64encode(raw).decode()",
          "    lines = [b[i:i + 76] for i in range(0, len(b), 76)]",
          '    sys.stdout.write("\\n".join([',
          '        f"-----BEGIN ABLATIONKIT ARCHIVE name={os.path.basename(ARCHIVE)} bytes={size} sha256={hashlib.sha256(raw).hexdigest()}-----",',
          `        *lines, ${JSON.stringify(ARCHIVE_END)}, ""]))`,
          `    print(${JSON.stringify(`No file downloaded? Copy the output from BEGIN to END into a file, then: ablationkit remote import ${input.jobId} --base64 FILE`)})`,
          "else:",
          '    print("the archive is", size, "bytes, too large to print: download it, or copy", ARCHIVE, "off the runtime")',
        ].join("\n"),
      ),
      cell(
        "markdown",
        [
          "## 4. Bring the results home",
          "",
          "On the coordinator's machine:",
          "",
          "```sh",
          `ablationkit remote import ${input.jobId} ak-${input.attemptId}-state.tgz`,
          "```",
          "",
          `If no file was downloaded, copy cell 3's output from \`-----BEGIN ABLATIONKIT ARCHIVE\` through \`-----END ABLATIONKIT ARCHIVE-----\` into a text file and run \`ablationkit remote import ${input.jobId} --base64 FILE\` (the size and SHA-256 are checked first).`,
          "",
          "Import is idempotent and deduplicated: events already delivered live are not applied twice.",
        ].join("\n"),
      ),
    ],
  };
}

/**
 * One cell to paste into an empty Colab notebook: it asks for the exported notebook (a file
 * upload), checks it is exactly the one exported for this attempt (SHA-256), and runs its code
 * cells in order. Getting a notebook file into Colab through its own "Upload notebook" dialog is
 * the step that fails most; pasting text and choosing a file does not need it.
 */
export function colabLoader(input: {
  attemptId: string;
  jobId: string;
  notebookSha256: string;
}): string {
  return [
    `# AblationKit loader: attempt ${input.attemptId} (job ${input.jobId}).`,
    `# Run this cell, choose ${input.attemptId}.ipynb when asked, and keep the tab open until it ends.`,
    "import hashlib, json",
    "from google.colab import files",
    "_up = files.upload()",
    '_name = next((n for n in _up if n.endswith(".ipynb")), None)',
    'assert _name, "choose the exported .ipynb file"',
    `assert hashlib.sha256(_up[_name]).hexdigest() == ${JSON.stringify(input.notebookSha256)}, "not the notebook exported for ${input.attemptId}: fetch it again with ablationkit remote notebook ${input.jobId}"`,
    "_nb = json.loads(_up[_name])",
    'for _i, _c in enumerate(c for c in _nb["cells"] if c["cell_type"] == "code"):',
    '    print(f"--- cell {_i + 1}", flush=True)',
    '    exec("".join(_c["source"]), globals())',
    "",
  ].join("\n");
}

export class ColabTarget implements TargetAdapter {
  readonly kind = "colab" as const;
  readonly capabilities: Capabilities = {
    submit: false,
    status: false,
    cancel: false,
    drain: false,
    independent_supervision: false,
    paid: false,
    exports: true,
  };

  constructor(readonly target: ComputeTarget) {}

  /** Write `notebook.ipynb` next to the bundle archive. */
  async stage(input: StageInput): Promise<void> {
    if (statSync(input.tgz).size > MAX_NOTEBOOK_BUNDLE)
      throw new TargetError(
        "bundle_too_large",
        "the bundle is over 64 MiB, too large to embed in a notebook; keep data out of Git",
      );
    const nb = colabNotebook(this.target, input, new Uint8Array(readFileSync(input.tgz)));
    writeFileSync(join(dirname(input.tgz), "notebook.ipynb"), `${JSON.stringify(nb, null, 1)}\n`, {
      mode: 0o600,
    });
  }

  async submit(input: StageInput): Promise<{ provider_job_id: string }> {
    return { provider_job_id: `colab:${input.attemptId}` };
  }

  async status(): Promise<ProviderStatus> {
    return { state: "exported", terminal: false };
  }

  async cancel(): Promise<void> {}

  async drain(): Promise<void> {
    throw new TargetError("cannot_drain", "Colab runtimes are not reachable; use `remote import`");
  }

  async reauthorize(): Promise<void> {
    throw new TargetError("not_supported", "export a new notebook instead");
  }

  async doctor(workerUrl: string): Promise<DoctorCheck[]> {
    return [
      {
        name: "unattended execution",
        ok: true,
        detail:
          "none: Colab targets export a notebook you run yourself; results come back with `remote import`",
      },
      {
        name: "live delivery",
        ok: true,
        detail: this.target.colab?.live
          ? `on: notebooks carry credentials and deliver to ${workerUrl} when Colab can reach it`
          : "off: notebooks carry no credentials",
      },
    ];
  }
}
