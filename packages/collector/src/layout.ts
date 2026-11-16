/**
 * Spool directory layout, shared by the coordinator (which creates it), the collector (its only
 * writer apart from the SDK's event file) and the Python SDK (ADR 0011).
 *
 *   <spool>/manifest.json         CollectorManifest, written by the coordinator
 *   <spool>/token                 worker token (0600), never put in the job's environment
 *   <spool>/sdk-events.jsonl      the SDK appends one EventEnvelope per line (O_APPEND)
 *   <spool>/sdk-offset.json       how far the collector has copied sdk-events.jsonl
 *   <spool>/journal/spool-NNNN.jsonl   durable, ordered spool (JournalEvent records)
 *   <spool>/cursor.json           highest spool seq the coordinator acknowledged
 *   <spool>/artifacts/<id>/<name> staged artifact bytes (SDK copies; collector globs)
 *   <spool>/uploads/<id>.json     pending artifact uploads; deleted once acknowledged
 *   <spool>/uploads/failed/       uploads the coordinator refused for good
 *   <spool>/exit.json             written once the job's process tree has ended
 *   <spool>/collector.pid, collector.log
 */
import { join, resolve } from "node:path";

export const COLLECTOR_VERSION = "0.1.0";
export const COLLECTOR_PRODUCER = "collector";

/** The collector's entry point, run by the coordinator with `bun <path> --spool <dir>`. */
export const COLLECTOR_MAIN = resolve(import.meta.dir, "main.ts");

export function spoolLayout(spool: string) {
  return {
    root: spool,
    manifest: join(spool, "manifest.json"),
    token: join(spool, "token"),
    sdkEvents: join(spool, "sdk-events.jsonl"),
    sdkOffset: join(spool, "sdk-offset.json"),
    journal: join(spool, "journal"),
    cursor: join(spool, "cursor.json"),
    artifacts: join(spool, "artifacts"),
    uploads: join(spool, "uploads"),
    failedUploads: join(spool, "uploads", "failed"),
    exit: join(spool, "exit.json"),
    pid: join(spool, "collector.pid"),
    log: join(spool, "collector.log"),
  } as const;
}
export type SpoolLayout = ReturnType<typeof spoolLayout>;

/** Environment variables the job (and so the SDK) receives. */
export const SDK_ENV = {
  eventsFile: "ABLATIONKIT_EVENTS_FILE",
  artifactDir: "ABLATIONKIT_ARTIFACT_DIR",
  projectId: "ABLATIONKIT_PROJECT_ID",
  jobId: "ABLATIONKIT_JOB_ID",
  attemptId: "ABLATIONKIT_ATTEMPT_ID",
} as const;

export const JOURNAL_NAME = "spool";
