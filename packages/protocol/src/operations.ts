/**
 * Coordinator operations (spec §5.3, §5.8, §13; ADR 0025): what a restore leaves behind in the
 * runtime directory, and the marker that retires a home after `coordinator move`.
 */
import { type Static, Type } from "@sinclair/typebox";
import { Timestamp } from "./common.ts";

export const RestoredProject = Type.Object(
  {
    project_id: Type.String({ minLength: 1, maxLength: 100 }),
    from_path: Type.String({ minLength: 1, maxLength: 4096 }),
    to_path: Type.String({ minLength: 1, maxLength: 4096 }),
    checkout: Type.Union(
      [Type.Literal("present"), Type.Literal("missing"), Type.Literal("wrong_project")],
      {
        description:
          "`present`: the checkout exists and its manifest names this project. `missing`: no checkout at `to_path` yet (clone it, or `project remap`). `wrong_project`: the manifest there names another project.",
      },
    ),
    files_written: Type.Integer({
      minimum: 0,
      description: "Backed-up research/ and .ablationkit/ files written because they were absent.",
    }),
    files_kept: Type.Array(Type.String({ maxLength: 4096 }), {
      maxItems: 200,
      description:
        "Files present in the checkout that differ from the backup; the checkout's copy was kept.",
    }),
  },
  { title: "RestoredProject", additionalProperties: false },
);
export type RestoredProject = Static<typeof RestoredProject>;

/** `<home>/restored.json`: written by `backup restore`, shown on the System page. */
export const RestoreRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    backup_id: Type.String({ minLength: 1, maxLength: 100 }),
    backup_reason: Type.String({ minLength: 1, maxLength: 50 }),
    backup_created_at: Timestamp,
    restored_at: Timestamp,
    source: Type.Optional(
      Type.Object(
        {
          hostname: Type.String({ minLength: 1, maxLength: 255 }),
          home: Type.String({ minLength: 1, maxLength: 4096 }),
        },
        { title: "RestoreSource", additionalProperties: false },
      ),
    ),
    hostname: Type.String({ minLength: 1, maxLength: 255, description: "Where it was restored." }),
    projects: Type.Array(RestoredProject),
    sessions_revoked: Type.Integer({
      minimum: 0,
      description: "Browser and CLI sessions revoked: every client logs in again.",
    }),
    settings_changes: Type.Array(Type.String({ maxLength: 500 }), {
      description: "Settings the restore changed (for example `remote.worker_url`).",
    }),
    extension_envs: Type.Array(Type.String({ maxLength: 300 }), {
      description:
        "Python extension builds (`<project>/<extension>@<build>`) whose environments are rebuilt from their lockfile on first use.",
    }),
    warnings: Type.Array(Type.String({ maxLength: 1000 })),
  },
  {
    title: "RestoreRecord",
    description: "What `backup restore` did to this runtime directory, for the System page.",
    additionalProperties: false,
  },
);
export type RestoreRecord = Static<typeof RestoreRecord>;

/**
 * `<home>/restore-pending.json`: a restore requested from the System page. The next
 * coordinator start applies it before anything else loads, moving the current contents aside.
 */
export const PendingRestore = Type.Object(
  {
    schema_version: Type.Literal(1),
    backup_id: Type.String({ pattern: "^[0-9]{8}T[0-9]{6}Z(-[a-z0-9-]{1,40})?$" }),
    requested_at: Timestamp,
    requested_by: Type.String({ minLength: 1, maxLength: 200 }),
  },
  {
    title: "PendingRestore",
    description: "A restore of one of this home's backups, applied at the next coordinator start.",
    additionalProperties: false,
  },
);
export type PendingRestore = Static<typeof PendingRestore>;

/**
 * `<home>/moved.json`: `coordinator move` retired this home. The coordinator refuses to start
 * while it exists, so the old and new machines never both accept writes (spec §5.3).
 */
export const CoordinatorMovedMarker = Type.Object(
  {
    schema_version: Type.Literal(1),
    moved_at: Timestamp,
    backup_id: Type.String({ minLength: 1, maxLength: 100 }),
    archive: Type.String({ minLength: 1, maxLength: 4096, description: "The archive written." }),
    archive_sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    hostname: Type.String({ minLength: 1, maxLength: 255 }),
  },
  {
    title: "CoordinatorMovedMarker",
    description:
      "This runtime directory was handed to another machine; starting here would make a second writable coordinator.",
    additionalProperties: false,
  },
);
export type CoordinatorMovedMarker = Static<typeof CoordinatorMovedMarker>;

/**
 * The desktop app's own settings (`$XDG_CONFIG_HOME/ablationkit/desktop.json`, spec §2.1; ADR
 * 0025): which coordinator it opens. Not coordinator state, and never sent to the coordinator.
 */
export const DesktopConfig = Type.Object(
  {
    schema_version: Type.Literal(1),
    mode: Type.Union([Type.Literal("managed"), Type.Literal("remote")], {
      description:
        "`managed`: the coordinator of a runtime directory on this machine, started if needed. `remote`: a coordinator elsewhere, reached over the tailnet (HTTPS) or loopback.",
    }),
    home: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4096,
        description: "Managed: the runtime directory (default ABLATIONKIT_HOME or ~/.ablationkit).",
      }),
    ),
    launch: Type.Optional(
      Type.Union([Type.Literal("service"), Type.Literal("child")], {
        description:
          "Managed: start it as the systemd user service (it keeps running after the app quits), or as a child of the app (stopped when the app quits). Default service.",
      }),
    ),
    remote_url: Type.Optional(
      Type.String({
        pattern: "^(https://[^/?#]+|http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]{1,5})?)/?$",
        description:
          "Remote: the coordinator's origin. HTTPS (for example `tailscale serve`), or plain http only on loopback.",
      }),
    ),
  },
  {
    title: "DesktopConfig",
    description: "Which coordinator the desktop app opens.",
    additionalProperties: false,
  },
);
export type DesktopConfig = Static<typeof DesktopConfig>;
