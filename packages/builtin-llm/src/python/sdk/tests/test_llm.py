"""ablationkit_llm: MLflow-format traces as `trace.logged` events, golden sets, prompts."""

from __future__ import annotations

import hashlib
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import ablationkit_llm as llm
import pytest

import ablationkit_sdk


@pytest.fixture
def events(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    (tmp_path / "artifacts").mkdir()
    f = tmp_path / "events.jsonl"
    monkeypatch.setenv("ABLATIONKIT_EVENTS_FILE", str(f))
    monkeypatch.setenv("ABLATIONKIT_ARTIFACT_DIR", str(tmp_path / "artifacts"))
    monkeypatch.delenv("ABLATIONKIT_GOLDEN_SET", raising=False)
    ablationkit_sdk._run._current = None
    return f


def _traces(f: Path) -> list[dict[str, Any]]:
    return [
        json.loads(x)["payload"]["trace"]
        for x in f.read_text().splitlines()
        if json.loads(x)["type"] == "trace.logged"
    ]


@pytest.fixture
def server() -> Iterator[str]:
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a: object) -> None:
            pass

        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            usage = (
                {}
                if body["model"].endswith("-nousage")
                else {"usage": {"prompt_tokens": 7, "completion_tokens": 2}}
            )
            data = json.dumps(
                {"model": body["model"], "choices": [{"message": {"content": "pong"}}], **usage}
            ).encode()
            self.send_response(200)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/v1"
    srv.shutdown()


def test_a_trace_is_one_event_with_mlflow_spans_tree_usage_and_errors(
    events: Path, server: str
) -> None:
    with llm.trace(
        "answer", inputs={"question": "q"}, example_id="e1", tags={"variant": "v2"}
    ) as t:
        with llm.span("retrieve", "RETRIEVER", inputs={"query": "q"}) as s:
            s.set_outputs(
                llm.documents(
                    [{"content": "c", "doc_uri": "faq.md", "chunk_id": "1", "score": 0.5}]
                )
            )
            s.set_attribute("ablationkit.rag.index_revision", "idx-1")
        with pytest.raises(TimeoutError), llm.span("lookup_order", "TOOL", inputs={"order": 7}):
            raise TimeoutError("slow")
        reply = llm.chat(
            [{"role": "user", "content": "ping"}],
            model="m",
            base_url=server,
            params={"temperature": 0},
        )
        t.set_outputs(reply.text)
    (tr,) = _traces(events)
    assert tr["trace_id"].startswith("tr-")
    assert len(tr["trace_id"]) == 35
    assert tr["state"] == "OK"  # a failed tool call does not fail the request
    assert tr["tags"] == {"ablationkit.variant": "v2", "ablationkit.example_id": "e1"}
    names = [(s["name"], json.loads(s["attributes"]["mlflow.spanType"])) for s in tr["spans"]]
    assert names == [
        ("answer", "AGENT"),
        ("retrieve", "RETRIEVER"),
        ("lookup_order", "TOOL"),
        ("chat_completion", "CHAT_MODEL"),
    ]
    root = tr["spans"][0]["span_id"]
    assert all(s["parent_span_id"] == root for s in tr["spans"][1:])
    assert len({s["trace_id"] for s in tr["spans"]}) == 1
    tool = tr["spans"][2]
    assert tool["status"]["code"] == "STATUS_CODE_ERROR"
    assert tool["events"][0]["attributes"] == {
        "exception.type": "TimeoutError",
        "exception.message": "slow",
    }
    chat = tr["spans"][3]["attributes"]
    assert json.loads(chat["mlflow.chat.tokenUsage"]) == {
        "input_tokens": 7,
        "output_tokens": 2,
        "total_tokens": 9,
    }
    assert json.loads(tr["spans"][1]["attributes"]["mlflow.spanOutputs"])[0]["metadata"] == {
        "doc_uri": "faq.md",
        "chunk_id": "1",
        "score": 0.5,
    }
    assert json.loads(tr["metadata"]["mlflow.trace.tokenUsage"])["total_tokens"] == 9
    assert reply.usage == {"input_tokens": 7, "output_tokens": 2, "total_tokens": 9}


def test_missing_usage_stays_missing_and_a_failed_request_is_an_error_trace(
    events: Path, server: str
) -> None:
    def fail() -> None:
        with llm.trace("answer") as t:
            r = llm.chat([{"role": "user", "content": "x"}], model="m-nousage", base_url=server)
            assert r.usage is None
            t.set_outputs(r.text)
            raise ValueError("bad")

    with pytest.raises(ValueError, match="bad"):
        fail()
    (tr,) = _traces(events)
    assert tr["state"] == "ERROR"
    assert "mlflow.chat.tokenUsage" not in tr["spans"][1]["attributes"]
    assert "mlflow.trace.tokenUsage" not in tr["metadata"]


def _export(root: Path) -> None:
    gs = root / ".ablationkit" / "llm" / "golden-sets"
    (gs / "faq").mkdir(parents=True)
    data = b'{"example_id":"e1","inputs":{"question":"q"},"category":"billing"}\n'
    (gs / "faq" / "v2.jsonl").write_bytes(data)
    idx = {
        "sets": [
            {
                "golden_set_id": "gs-abc123",
                "name": "faq",
                "version": 2,
                "path": "faq/v2.jsonl",
                "export_sha256": hashlib.sha256(data).hexdigest(),
                "inputs_only": True,
            }
        ]
    }
    (gs / "index.json").write_text(json.dumps(idx))
    pr = root / ".ablationkit" / "llm" / "prompts"
    pr.mkdir(parents=True)
    (pr / "qa.json").write_text(
        json.dumps(
            {
                "name": "qa",
                "exported_at": "2026-11-04T00:00:00Z",
                "aliases": {"champion": 1},
                "versions": {
                    "1": {
                        "template": [{"role": "user", "content": "Q: {{question}}"}],
                        "format": "chat",
                        "sha256": "a" * 64,
                    },
                    "2": {"template": "A {{question}}", "format": "text", "sha256": "b" * 64},
                },
            }
        )
    )


def test_golden_sets_and_prompts_come_from_the_checkout_export(
    events: Path, tmp_path: Path
) -> None:
    _export(tmp_path)
    ex = llm.golden_set("faq", root=tmp_path)
    assert ex == [llm.GoldenExample("e1", {"question": "q"}, None, "billing")]
    with llm.trace("answer", example_id="e1"):
        pass
    assert _traces(events)[0]["tags"]["ablationkit.golden_set"] == "gs-abc123/2"
    t, prov = llm.load_prompt("qa@champion", root=tmp_path)
    assert prov == {
        "name": "qa",
        "version": 1,
        "sha256": "a" * 64,
        "format": "chat",
        "alias": "champion",
        "alias_as_of": "2026-11-04T00:00:00Z",
    }
    assert llm.render(t, {"question": "hi"}) == [{"role": "user", "content": "Q: hi"}]
    assert llm.load_prompt("qa", root=tmp_path)[1]["version"] == 2
    with pytest.raises(KeyError):
        llm.render(t, {})
    with pytest.raises(LookupError):
        llm.golden_set("nope", root=tmp_path)
    (tmp_path / ".ablationkit/llm/golden-sets/faq/v2.jsonl").write_text("tampered\n")
    with pytest.raises(ValueError, match="does not match"):
        llm.golden_set("faq", root=tmp_path)


def test_outside_ablationkit_nothing_is_recorded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ABLATIONKIT_EVENTS_FILE", raising=False)
    ablationkit_sdk._run._current = None
    with pytest.warns(RuntimeWarning), llm.trace("x") as t:
        t.set_outputs(1)
