/**
 * Files in an agent's home, which the agent writes while the coordinator does (ADR 0061): its
 * `.profile`, `.gitconfig`, linked skills and Claude Code's login and settings (ADR 0063). The home
 * is kept between sessions, so anything in it may be a symbolic link the agent planted, or swaps in
 * between two calls. Every path here is reached from the home down one directory at a time, each
 * opened without following a link, and the last step goes through the opened directory's
 * `/proc/self/fd` entry (the kernel's `openat`): no link is ever followed onto this machine's
 * files. A link standing where AblationKit needs a directory is removed (it is the agent's, in the
 * agent's home); a link where a file is read reads as no file, and one where a file is written is
 * replaced. Reads refuse anything but a regular file, and FIFOs never block (`O_NONBLOCK`).
 *
 * Linux only, as agent containers are.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";

const { O_APPEND, O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_WRONLY } =
  constants;

/** The largest file read from an agent's home (Claude Code's settings are well under it). */
const MAX_READ = 8 * 1024 * 1024;

const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

function parts(rel: string): { dirs: string[]; leaf: string } {
  const all = rel.split("/").filter((p) => p !== "" && p !== ".");
  const leaf = all.pop();
  if (!leaf || all.includes("..") || leaf === "..")
    throw new Error(`not a path in the agent's home: ${rel}`);
  return { dirs: all, leaf };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export class AgentHome {
  constructor(readonly root: string) {}

  /**
   * Open the directory `dirs` (from the home down, without following links) and pass its fd to
   * `fn`. With `create`, missing directories are made and links in their place removed; without,
   * a missing or linked directory gives undefined.
   */
  private within<T>(dirs: string[], create: boolean, fn: (fd: number) => T): T | undefined {
    let fd = openSync(this.root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    try {
      for (const name of dirs) {
        const next = this.openDir(fd, name, create);
        if (next === undefined) return undefined;
        closeSync(fd);
        fd = next;
      }
      return fn(fd);
    } finally {
      closeSync(fd);
    }
  }

  private openDir(parent: number, name: string, create: boolean): number | undefined {
    const p = at(parent, name);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return openSync(p, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      } catch (e) {
        if (!create) return undefined;
        const c = code(e);
        if (c === "ENOENT") {
          try {
            mkdirSync(p, { mode: 0o700 });
          } catch (m) {
            if (code(m) !== "EEXIST") throw m;
          }
        } else if ((c === "ELOOP" || c === "ENOTDIR") && isLink(p)) {
          unlinkSync(p);
        } else {
          throw e;
        }
      }
    }
    throw new Error(`could not open ${name} in the agent's home`);
  }

  /** The text of the regular file `rel`, or undefined (missing, a link, not a file, too large). */
  read(rel: string): string | undefined {
    const { dirs, leaf } = parts(rel);
    try {
      return this.within(dirs, false, (dir) => {
        let fd: number;
        try {
          fd = openSync(at(dir, leaf), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
        } catch {
          return undefined;
        }
        try {
          const st = fstatSync(fd);
          if (!st.isFile() || st.size > MAX_READ) return undefined;
          return readFileSync(fd, "utf8");
        } finally {
          closeSync(fd);
        }
      });
    } catch {
      return undefined;
    }
  }

  /** The modification time of `rel` itself (a link's own), or 0 when there is none. */
  mtime(rel: string): number {
    const { dirs, leaf } = parts(rel);
    try {
      return this.within(dirs, false, (dir) => lstatSync(at(dir, leaf)).mtimeMs) ?? 0;
    } catch {
      return 0;
    }
  }

  /** Does `rel` exist (a link counts, unfollowed)? */
  exists(rel: string): boolean {
    const { dirs, leaf } = parts(rel);
    try {
      return (
        this.within(dirs, false, (dir) => {
          lstatSync(at(dir, leaf));
          return true;
        }) ?? false
      );
    } catch {
      return false;
    }
  }

  /** Write `rel` whole, the way a reader never sees half of: a new file renamed over it. */
  write(rel: string, text: string, mode = 0o600): void {
    const { dirs, leaf } = parts(rel);
    this.within(dirs, true, (dir) => {
      const tmp = `.${leaf}.ablationkit-${process.pid}.tmp`;
      try {
        unlinkSync(at(dir, tmp));
      } catch {
        // None left over.
      }
      const fd = openSync(at(dir, tmp), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
      try {
        writeSync(fd, text);
        fchmodSync(fd, mode);
      } finally {
        closeSync(fd);
      }
      try {
        renameSync(at(dir, tmp), at(dir, leaf));
      } catch (e) {
        try {
          unlinkSync(at(dir, tmp));
        } catch {
          // Already gone.
        }
        throw e;
      }
    });
  }

  /** Append to the regular file `rel` (created when missing; a link in its place is replaced). */
  append(rel: string, text: string, mode = 0o600): void {
    const { dirs, leaf } = parts(rel);
    this.within(dirs, true, (dir) => {
      const p = at(dir, leaf);
      if (isLink(p)) unlinkSync(p);
      const fd = openSync(p, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, mode);
      try {
        if (!fstatSync(fd).isFile()) throw new Error(`${rel} in the agent's home is not a file`);
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
    });
  }

  /** Remove `rel` itself (a link, never what it points to). */
  remove(rel: string): void {
    const { dirs, leaf } = parts(rel);
    try {
      this.within(dirs, false, (dir) => unlinkSync(at(dir, leaf)));
    } catch {
      // Already gone.
    }
  }

  /** Make the directory `rel` (and its parents), links in the way removed. */
  mkdir(rel: string): void {
    const { dirs, leaf } = parts(rel);
    this.within([...dirs, leaf], true, () => undefined);
  }

  /** Create the link `rel` → `target`; false when something is already there. */
  symlink(target: string, rel: string): boolean {
    const { dirs, leaf } = parts(rel);
    try {
      return (
        this.within(dirs, true, (dir) => {
          symlinkSync(target, at(dir, leaf));
          return true;
        }) ?? false
      );
    } catch {
      return false;
    }
  }
}
