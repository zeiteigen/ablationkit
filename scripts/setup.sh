#!/bin/sh
# AblationKit developer setup: run the CLI from this checkout, install its Agent Skills and
# register its MCP server with your agent harnesses.
#
#   sh scripts/setup.sh                    install deps, put ablationkit on PATH, link the skills,
#                                          register the MCP server
#   sh scripts/setup.sh --prefix DIR       launcher goes in DIR/bin (default ~/.local)
#   sh scripts/setup.sh --no-deps          skip bun install / uv sync
#   sh scripts/setup.sh --no-mcp           don't register the executive's MCP server
#   sh scripts/setup.sh --agent-mcp        also register the agents' MCP server (`ablationkit mcp`),
#                                          for research agents you run on this machine uncontained
#   sh scripts/setup.sh --guard            also apply the agent guard to registered projects (opt-in)
#   sh scripts/setup.sh --claude-config D  also set up the Claude Code config in D (CLAUDE_CONFIG_DIR)
#   sh scripts/setup.sh --force            replace an ablationkit launcher or MCP entry this script
#                                          did not write
#   sh scripts/setup.sh --uninstall        remove the launcher, the skill links into this checkout
#                                          and the MCP entries pointing at the launcher
#
# The launcher runs apps/cli/src/main.ts from this checkout, so edits take effect immediately.
# For an installed release instead, use scripts/packaging/install.sh (ADR 0028). Claude Code configs: the
# default (~/.claude, ~/.claude.json) and every ~/.claude-*/ holding a .claude.json (a second
# profile run with CLAUDE_CONFIG_DIR, such as a claude-pro wrapper), plus --claude-config. Each
# gets the skills (<config>/skills) and, at user scope, the `ablationkit` MCP server
# (`ablationkit mcp`, ADR 0040). Codex gets both when its home (CODEX_HOME, default ~/.codex)
# exists (skills/README.md). Restart agent sessions afterwards so they pick them up. Agents on
# this machine are your executives: they get `ablationkit executive` (ADR 0064), not the agents'
# `ablationkit mcp`, which research agents get in their agent containers (`ablationkit agent
# start`, ADR 0061); --agent-mcp registers it here too. They may also use the CLI (ADR 0062).
# --guard still writes the agent guard (ADR 0041) into registered projects, for agents you run
# uncontained here; `ablationkit project unguard --all` takes it out.
# Your data in ${ABLATIONKIT_HOME:-~/.ablationkit} is never touched.
set -eu

MARKER="# ablationkit dev launcher (scripts/setup.sh)"

prefix="${HOME}/.local"
deps=1
mcp=1
agent_mcp=0
guard=0
force=0
uninstall=0
claude_extra=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --no-deps) deps=0; shift ;;
    --no-mcp) mcp=0; shift ;;
    --agent-mcp) agent_mcp=1; shift ;;
    --guard) guard=1; shift ;;
    --no-guard) guard=0; shift ;;
    --claude-config) claude_extra="$claude_extra $2"; shift 2 ;;
    --force) force=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "setup.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

fail() { echo "setup.sh: $*" >&2; exit 1; }

root=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$root/apps/cli/src/main.ts" ] && [ -d "$root/skills" ] \
  || fail "run this from an AblationKit source checkout"

bindir="$prefix/bin"
launcher="$bindir/ablationkit"

# Claude Code configs: "default" (no CLAUDE_CONFIG_DIR) plus every other profile directory.
claude_cfgs="default"
for d in "$HOME"/.claude-*/ $claude_extra; do
  d=${d%/}
  [ -d "$d" ] || continue
  case "$d" in "$HOME"/.claude-*) [ -f "$d/.claude.json" ] || continue ;; esac
  case " $claude_cfgs " in *" $d "*) ;; *) claude_cfgs="$claude_cfgs $d" ;; esac
done
cfg_skills() { if [ "$1" = default ]; then echo "$HOME/.claude/skills"; else echo "$1/skills"; fi; }
cfg_json() { if [ "$1" = default ]; then echo "$HOME/.claude.json"; else echo "$1/.claude.json"; fi; }
cfg_label() { if [ "$1" = default ]; then echo "Claude Code"; else echo "Claude Code ($1)"; fi; }
claude_in() {
  cfg=$1; shift
  if [ "$cfg" = default ]; then env -u CLAUDE_CONFIG_DIR claude "$@"; else CLAUDE_CONFIG_DIR="$cfg" claude "$@"; fi
}

skill_dirs=""
for cfg in $claude_cfgs; do skill_dirs="$skill_dirs $(cfg_skills "$cfg")"; done
codex_home="${CODEX_HOME:-$HOME/.codex}"
[ -d "$codex_home" ] && skill_dirs="$skill_dirs $codex_home/skills"

# The MCP servers, as name:subcommand: the executive's (`ablationkit executive`, ADR 0064), which
# is what agents on this machine get, and the agents' (`ablationkit mcp`, ADR 0040), which research
# agents get inside their agent containers, and on this machine only with --agent-mcp.
mcp_servers="ablationkit:mcp ablationkit-executive:executive"

# The command an existing MCP entry named $2 runs ("" when there is none). Read from the config
# file, not `claude mcp get`, whose health check would start (and mint) a session.
claude_mcp_command() {
  f=$(cfg_json "$1")
  [ -f "$f" ] || return 0
  bun_bin=$(command -v bun || true)
  [ -n "$bun_bin" ] || return 0
  "$bun_bin" -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const s=j.mcpServers&&j.mcpServers[process.argv[2]];if(s)console.log(s.command??"?")}catch{}' "$f" "$2"
}
# `codex mcp get` only reads the config (no health check).
codex_mcp_command() {
  codex mcp get "$1" 2>/dev/null | sed -n 's/^ *command: //p' | head -n 1
}

# A launcher is ours when it carries the marker or execs this checkout's CLI.
ours() {
  [ -f "$1" ] && [ ! -L "$1" ] \
    && { grep -qF "$MARKER" "$1" || grep -qF "$root/apps/cli/src/main.ts" "$1"; }
}

if [ "$uninstall" = 1 ]; then
  if ours "$launcher"; then
    rm -f "$launcher"
    echo "removed $launcher"
  elif [ -e "$launcher" ] || [ -L "$launcher" ]; then
    echo "kept $launcher: not a launcher for this checkout"
  fi
  for dir in $skill_dirs; do
    [ -d "$dir" ] || continue
    for link in "$dir"/*; do
      [ -L "$link" ] || continue
      case "$(readlink "$link")" in
        "$root"/*) rm -f "$link"; echo "unlinked $link" ;;
      esac
    done
  done
  for entry in $mcp_servers; do
    name=${entry%%:*}
    if command -v claude >/dev/null 2>&1; then
      for cfg in $claude_cfgs; do
        if [ "$(claude_mcp_command "$cfg" "$name")" = "$launcher" ]; then
          claude_in "$cfg" mcp remove --scope user "$name" >/dev/null 2>&1 \
            && echo "removed the $name MCP server from $(cfg_label "$cfg")"
        fi
      done
    fi
    if command -v codex >/dev/null 2>&1 && [ "$(codex_mcp_command "$name")" = "$launcher" ]; then
      codex mcp remove "$name" >/dev/null 2>&1 && echo "removed the $name MCP server from Codex"
    fi
  done
  exit 0
fi

# Prerequisites
bun=$(command -v bun || true)
[ -n "$bun" ] || fail "bun is required (Arch: pacman -S bun; elsewhere: https://bun.sh)"
"$bun" -e 'const [a,b,c]=Bun.version.split(".").map(Number);process.exit(a>1||(a===1&&(b>4||(b===4&&c>=4)))?0:1)' \
  || fail "bun $("$bun" --version) is older than 1.4.4"
command -v git >/dev/null 2>&1 || fail "git is required"
command -v uv >/dev/null 2>&1 || echo "note: uv not found; the managed MLflow and Python jobs need it"

# Dependencies
if [ "$deps" = 1 ]; then
  echo "installing dependencies in $root"
  (cd "$root" && "$bun" install --frozen-lockfile)
  if command -v uv >/dev/null 2>&1; then
    (cd "$root" && uv sync --locked)
  fi
fi

# Launcher
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  if ! ours "$launcher" && [ "$force" != 1 ]; then
    if [ -L "$launcher" ]; then
      what="a link to $(readlink "$launcher")"
    else
      what="a file this script did not write"
    fi
    fail "$launcher is $what (a packaged install?); remove it, run scripts/packaging/install.sh --uninstall, or pass --force"
  fi
fi
mkdir -p "$bindir"
tmp="$launcher.new.$$"
cat > "$tmp" <<EOF
#!/bin/sh
$MARKER
# Runs the CLI from the checkout at $root.
bun=\${ABLATIONKIT_BUN:-\$(command -v bun || true)}
[ -n "\$bun" ] || bun="$bun"
if [ ! -x "\$bun" ]; then
  echo "ablationkit: bun not found; install it or set ABLATIONKIT_BUN" >&2
  exit 127
fi
exec "\$bun" "$root/apps/cli/src/main.ts" "\$@"
EOF
chmod 755 "$tmp"
mv -f "$tmp" "$launcher"
echo "installed $launcher -> $root/apps/cli/src/main.ts"

# Skills: every skills/<name>/ with a SKILL.md
linked=0
for dir in $skill_dirs; do
  mkdir -p "$dir"
  for src in "$root"/skills/*/; do
    src=${src%/}
    [ -f "$src/SKILL.md" ] || continue
    name=$(basename "$src")
    dest="$dir/$name"
    if [ -L "$dest" ]; then
      old=$(readlink "$dest")
      [ "$old" = "$src" ] && continue
      ln -sfn "$src" "$dest"
      echo "relinked $dest (was $old)"
    elif [ -e "$dest" ]; then
      echo "skipped $dest: a real directory is there, not a link; remove it to use the checkout's"
      continue
    else
      ln -s "$src" "$dest"
    fi
    linked=$((linked + 1))
  done
  echo "skills linked in $dir"
done

# MCP servers, at user scope so they work in every registered project (they find the project
# from the directory they start in). Agents on this machine are executives (ADR 0064): they get
# `ablationkit executive`. Research agents run in agent containers, which register `ablationkit
# mcp` for themselves; on this machine it is registered only with --agent-mcp, and an entry for
# this launcher left by an earlier setup is taken out.
registered=0
if [ "$mcp" = 1 ]; then
  if [ "$agent_mcp" != 1 ]; then
    if command -v claude >/dev/null 2>&1; then
      for cfg in $claude_cfgs; do
        if [ "$(claude_mcp_command "$cfg" ablationkit)" = "$launcher" ]; then
          claude_in "$cfg" mcp remove --scope user ablationkit >/dev/null 2>&1 \
            && echo "removed the agents' ablationkit MCP server from $(cfg_label "$cfg") (agents here are executives; --agent-mcp keeps it)"
        fi
      done
    fi
    if command -v codex >/dev/null 2>&1 && [ "$(codex_mcp_command ablationkit)" = "$launcher" ]; then
      codex mcp remove ablationkit >/dev/null 2>&1 \
        && echo "removed the agents' ablationkit MCP server from Codex (agents here are executives; --agent-mcp keeps it)"
    fi
  fi
  for entry in $mcp_servers; do
    name=${entry%%:*}
    sub=${entry#*:}
    [ "$name" = ablationkit ] && [ "$agent_mcp" != 1 ] && continue
    if command -v claude >/dev/null 2>&1; then
      for cfg in $claude_cfgs; do
        label=$(cfg_label "$cfg")
        current=$(claude_mcp_command "$cfg" "$name")
        if [ "$current" = "$launcher" ]; then
          echo "$name MCP server already registered in $label"
          continue
        elif [ -n "$current" ]; then
          if [ "$force" != 1 ]; then
            echo "skipped $label: its $name MCP server runs $current; pass --force to replace it"
            continue
          fi
          claude_in "$cfg" mcp remove --scope user "$name" >/dev/null 2>&1 || true
        fi
        claude_in "$cfg" mcp add --scope user "$name" -- "$launcher" "$sub" >/dev/null
        echo "registered the $name MCP server in $label"
        registered=$((registered + 1))
      done
    else
      echo "note: claude not found; register the MCP server later: claude mcp add --scope user $name -- $launcher $sub"
    fi
    if [ -d "$codex_home" ] && command -v codex >/dev/null 2>&1; then
      current=$(codex_mcp_command "$name")
      if [ "$current" = "$launcher" ]; then
        echo "$name MCP server already registered in Codex"
      elif [ -n "$current" ] && [ "$force" != 1 ]; then
        echo "skipped Codex: its $name MCP server runs $current; pass --force to replace it"
      else
        [ -n "$current" ] && codex mcp remove "$name" >/dev/null 2>&1
        codex mcp add "$name" -- "$launcher" "$sub" >/dev/null
        echo "registered the $name MCP server in Codex"
        registered=$((registered + 1))
      fi
    fi
  done
fi

# Agent guard, on request (--guard): project-scoped rules that keep agents out of the
# coordinator home and each checkout's .ablationkit/ (ADR 0041; opt-in since ADR 0062).
ak_home="${ABLATIONKIT_HOME:-$HOME/.ablationkit}"
if [ "$guard" = 1 ] && [ -f "$ak_home/registry.json" ]; then
  echo "applying the agent guard to registered projects"
  "$bun" "$root/apps/cli/src/main.ts" project guard --all \
    || echo "note: the agent guard could not be applied; run: ablationkit project guard --all"
fi

case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "add $bindir to PATH to run ablationkit" ;;
esac
[ "$linked" -gt 0 ] || [ "$registered" -gt 0 ] \
  && echo "restart Claude Code / Codex sessions to pick up new skills and the MCP server"
echo "next: ablationkit dev doctor"
