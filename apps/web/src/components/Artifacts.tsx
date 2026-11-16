/**
 * Artifact browser (spec §5.6): directory listing, previews and downloads. Previews are decided by
 * the content type the coordinator serves (text, JSON or raster images only) and a size cap;
 * everything else is a download. Formats that execute code when loaded (pickle, torch, joblib…)
 * show a trust warning first. Artifacts are never rendered as HTML on the coordinator origin.
 */
import { useEffect, useState } from "react";
import { qs, useApi } from "../api.ts";
import {
  fmtBytes,
  isUnsafeModelFormat,
  PREVIEW_MAX_BYTES,
  type PreviewKind,
  previewKind,
} from "../lib/format.ts";
import { Badge, Empty, ErrorBox, Loading, Modal } from "./ui.tsx";

interface FileInfo {
  path: string;
  is_dir: boolean;
  file_size?: number;
}

export function ArtifactBrowser(props: { runId: string }) {
  const [dir, setDir] = useState("");
  const [file, setFile] = useState<FileInfo>();
  const list = useApi<{ files?: FileInfo[]; state?: string; next_page_token?: string }>(
    `/api/v1/tracking/runs/${encodeURIComponent(props.runId)}/artifacts${qs({ path: dir })}`,
  );
  const crumbs = dir ? dir.split("/") : [];
  return (
    <div className="grid2">
      <div className="card">
        <div className="row small" style={{ marginBottom: 8 }}>
          <button type="button" className="link" onClick={() => setDir("")}>
            artifacts
          </button>
          {crumbs.map((c, i) => (
            <span key={crumbs.slice(0, i + 1).join("/")}>
              /{" "}
              <button
                type="button"
                className="link"
                onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))}
              >
                {c}
              </button>
            </span>
          ))}
        </div>
        <ErrorBox error={list.error} />
        {list.data?.state === "tracking_pending" ? (
          <div className="banner warn">MLflow has not acknowledged this run yet.</div>
        ) : null}
        {list.loading && !list.data ? <Loading /> : null}
        {list.data?.files?.length === 0 ? <Empty>No artifacts here.</Empty> : null}
        {list.data?.files?.length ? (
          <div className="table-wrap">
            <table data-testid="artifacts-table">
              <tbody>
                {list.data.files.map((f) => (
                  <tr key={f.path} className={file?.path === f.path ? "selected" : ""}>
                    <td>
                      <button
                        type="button"
                        className="link"
                        onClick={() => (f.is_dir ? setDir(f.path) : setFile(f))}
                      >
                        {f.is_dir ? "📁 " : ""}
                        {f.path.split("/").at(-1)}
                      </button>
                      {!f.is_dir && isUnsafeModelFormat(f.path) ? (
                        <Badge tone="warn" title="Loading this format can execute code">
                          untrusted format
                        </Badge>
                      ) : null}
                    </td>
                    <td className="num small faint">{f.is_dir ? "" : fmtBytes(f.file_size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      <div className="card">
        {file ? (
          <Preview runId={props.runId} file={file} />
        ) : (
          <p className="muted small">Select a file to preview.</p>
        )}
      </div>
    </div>
  );
}

function Preview(props: { runId: string; file: FileInfo }) {
  const url = `/api/v1/tracking/runs/${encodeURIComponent(props.runId)}/artifacts/download${qs({ path: props.file.path })}`;
  const [kind, setKind] = useState<PreviewKind>();
  const [text, setText] = useState<string>();
  const [img, setImg] = useState<string>();
  const [type, setType] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [warn, setWarn] = useState(false);
  const tooBig = (props.file.file_size ?? 0) > PREVIEW_MAX_BYTES;
  const isJsonName = props.file.path.toLowerCase().endsWith(".json");

  useEffect(() => {
    setKind(undefined);
    setText(undefined);
    setImg(undefined);
    setError(undefined);
    if (tooBig) {
      setKind("none");
      return;
    }
    const ac = new AbortController();
    let objectUrl: string | undefined;
    fetch(url, { signal: ac.signal, credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
          throw new Error(j.error?.message ?? `HTTP ${r.status}`);
        }
        const ct = r.headers.get("content-type");
        setType(ct ?? undefined);
        const k = previewKind(ct, props.file.file_size);
        if (k === "image") {
          objectUrl = URL.createObjectURL(await r.blob());
          setImg(objectUrl);
        } else if (k === "text" || k === "json") {
          const t = await r.text();
          // MLflow serves JSON as text/plain; pretty-print it when it parses.
          if (k === "json" || isJsonName) {
            try {
              setText(JSON.stringify(JSON.parse(t), null, 2));
            } catch {
              setText(t);
            }
          } else setText(t);
        } else {
          ac.abort();
        }
        setKind(k);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      });
    return () => {
      ac.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, tooBig, isJsonName, props.file.file_size]);

  const unsafe = isUnsafeModelFormat(props.file.path);
  return (
    <div className="stack" data-testid="artifact-preview">
      <div className="row">
        <strong className="mono small">{props.file.path}</strong>
        <span className="faint small">{fmtBytes(props.file.file_size)}</span>
        {unsafe ? (
          <button
            type="button"
            className="small"
            onClick={() => setWarn(true)}
            style={{ marginLeft: "auto" }}
          >
            Download…
          </button>
        ) : (
          <a className="btn small" href={url} download style={{ marginLeft: "auto" }}>
            Download
          </a>
        )}
      </div>
      <ErrorBox error={error} />
      {kind === undefined && !error ? <Loading /> : null}
      {kind === "none" ? (
        <p className="muted small">
          {tooBig
            ? `No preview: larger than ${fmtBytes(PREVIEW_MAX_BYTES)}.`
            : `No preview for ${type ?? "this content type"}; download it instead.`}
        </p>
      ) : null}
      {text !== undefined ? <pre className="console">{text}</pre> : null}
      {img ? <img className="preview-img" src={img} alt={props.file.path} /> : null}
      {warn ? (
        <Modal
          title="Untrusted model format"
          onClose={() => setWarn(false)}
          footer={
            <>
              <button type="button" onClick={() => setWarn(false)}>
                Cancel
              </button>
              <a className="btn primary" href={url} download onClick={() => setWarn(false)}>
                Download anyway
              </a>
            </>
          }
        >
          <p>
            <strong>{props.file.path.split("/").at(-1)}</strong> uses a format that can run
            arbitrary code when it is loaded (for example with <code>pickle</code>,{" "}
            <code>torch.load</code> or <code>joblib</code>).
          </p>
          <p className="muted small">
            Only load it if you trust the job that produced it. Prefer <code>safetensors</code> or{" "}
            <code>torch.load(..., weights_only=True)</code>.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
