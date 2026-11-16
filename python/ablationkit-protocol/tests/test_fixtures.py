"""Validate the shared fixtures in packages/protocol/fixtures against the generated models."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from ablationkit_protocol import MODELS, SCHEMA_VERSIONS, EventEnvelope, ProjectManifest

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "protocol" / "fixtures"
FILES = {
    "EventEnvelope": "event-envelope.v1.json",
    "JournalEvent": "journal-event.v1.json",
    "ProjectManifest": "project-manifest.v1.json",
    "ProjectRegistry": "project-registry.v1.json",
    "CoordinatorSettings": "coordinator-settings.v1.json",
    "AuditRecord": "audit-record.v1.json",
    "TokenStore": "token-store.v1.json",
    "TrackingRunMapping": "tracking-run-mapping.v1.json",
    "TrackingProjectLinks": "tracking-project-links.v1.json",
    "TrackingOutboxRecord": "tracking-outbox-record.v1.json",
    "MlflowSidecarState": "mlflow-sidecar-state.v1.json",
    "BackupManifest": "backup-manifest.v1.json",
    "RestoreRecord": "restore-record.v1.json",
    "PendingRestore": "pending-restore.v1.json",
    "CoordinatorMovedMarker": "coordinator-moved-marker.v1.json",
    "DesktopConfig": "desktop-config.v1.json",
    "JobRecord": "job-record.v1.json",
    "AttemptRecord": "attempt-record.v1.json",
    "IngestState": "ingest-state.v1.json",
    "ConsoleRecord": "console-record.v1.json",
    "CollectorManifest": "collector-manifest.v1.json",
    "ResearchRecord": "research-record.v1.json",
    "ResearchExportState": "research-export-state.v1.json",
    "ReviewState": "review-state.v1.json",
    "ProjectActionPolicy": "project-action-policy.v2.json",
    "ComputeTarget": "compute-target.v1.json",
    "ComputeWeights": "compute-weights.v1.json",
    "ComputeLimitState": "compute-limit-state.v1.json",
    "RunBundleManifest": "run-bundle-manifest.v1.json",
    "WorkerHandshake": "worker-handshake.v1.json",
    "WorkerHandshakeReply": "worker-handshake-reply.v1.json",
    "ResumableUpload": "resumable-upload.v1.json",
    "WorkerCredentials": "worker-credentials.v1.json",
    "ResearchTask": "research-task.v2.json",
    "DeploymentRecord": "deployment-record.v1.json",
    "ModelLink": "model-link.v1.json",
    "RegistryVersionLink": "registry-version-link.v1.json",
    "EvaluationRecord": "evaluation-record.v1.json",
    "InferenceSessionRecord": "inference-session-record.v1.json",
    "InferenceEvidenceRecord": "inference-evidence-record.v1.json",
    "LlmSettings": "llm-settings.v1.json",
    "GoldenSetRecord": "golden-set-record.v1.json",
    "LlmEvaluationRecord": "llm-evaluation-record.v1.json",
    "LlmEvidenceRecord": "llm-evidence-record.v1.json",
    "ExtensionManifest": "extension-manifest.v1.json",
    "ExtensionState": "extension-state.v1.json",
    "ExtensionBuildRecord": "extension-build-record.v1.json",
    "ExtensionExecutionRecord": "extension-execution-record.v1.json",
    "SourceBuildRecord": "source-build-record.v1.json",
    "VaultNote": "vault-note.v1.json",
    "VaultIndex": "vault-index.v1.json",
    "VaultReadState": "vault-read-state.v1.json",
    "Agenda": "agenda.v1.json",
    "AgendaSeen": "agenda-seen.v1.json",
    "VaultWork": "vault-work.v1.json",
    "VaultSetAside": "vault-set-aside.v1.json",
    "ResearchDirection": "research-direction.v1.json",
}


def _load(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((FIXTURES / FILES[name]).read_text(encoding="utf-8"))
    return data


def _cases(kind: str) -> list[Any]:
    return [
        pytest.param(name, case, id=f"{name}-{i}")
        for name in FILES
        for i, case in enumerate(_load(name)[kind])
    ]


def test_every_model_has_fixtures() -> None:
    assert set(MODELS) == set(FILES)
    assert set(SCHEMA_VERSIONS) == set(FILES)


@pytest.mark.parametrize(("name", "doc"), _cases("valid"))
def test_valid_fixture_round_trips(name: str, doc: dict[str, Any]) -> None:
    model = MODELS[name].from_json(json.dumps(doc))
    assert model.to_json_obj() == doc
    assert json.loads(model.to_json()) == doc


@pytest.mark.parametrize(("name", "case"), _cases("invalid"))
def test_invalid_fixture_rejected(name: str, case: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        MODELS[name].from_json(json.dumps(case["value"]))


def test_python_constructed_null_is_rejected() -> None:
    with pytest.raises(ValidationError):
        ProjectManifest(schema_version=1, project_id="lab", name="Lab", description=None)


def test_unset_optional_fields_are_omitted() -> None:
    m = ProjectManifest(schema_version=1, project_id="lab", name="Lab")
    assert m.to_json_obj() == {"schema_version": 1, "project_id": "lab", "name": "Lab"}


def test_models_are_immutable() -> None:
    e = EventEnvelope.from_json(json.dumps(_load("EventEnvelope")["valid"][0]))
    with pytest.raises(ValidationError):
        e.producer_seq = 5  # type: ignore[misc]
