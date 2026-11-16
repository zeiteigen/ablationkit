#!/bin/sh
# AblationKit per-user install (ADR 0028). No root, no system files.
#
#   sh install.sh                      from an unpacked release: install it
#   sh scripts/packaging/install.sh            from a source checkout: stage it first (bun run package)
#   sh install.sh --prefix DIR         default ~/.local
#   sh install.sh --uninstall          remove the install; ~/.ablationkit (your data) is kept
#
# Installs to PREFIX/share/ablationkit/VERSION, points PREFIX/share/ablationkit/current at it,
# and links PREFIX/bin/ablationkit and ablationkit-desktop. The previous version stays until the
# next install, so a coordinator still running from it keeps working until it restarts.
set -eu

prefix="${HOME}/.local"
uninstall=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

base="$prefix/share/ablationkit"
bindir="$prefix/bin"
apps="$prefix/share/applications"
icons="$prefix/share/icons/hicolor/scalable/apps"

if [ "$uninstall" = 1 ]; then
  rm -f "$bindir/ablationkit" "$bindir/ablationkit-desktop" "$apps/ablationkit.desktop" \
    "$icons/ablationkit.svg"
  rm -rf "$base"
  echo "removed AblationKit from $prefix; your data in \${ABLATIONKIT_HOME:-~/.ablationkit} is kept"
  echo "a user service you started stays installed: ablationkit-coordinator.service (stop it with systemctl --user disable --now ablationkit-coordinator.service)"
  exit 0
fi

fail() { echo "install.sh: $*" >&2; exit 1; }

bun=$(command -v bun || true)
[ -n "$bun" ] || fail "bun is required (Arch: pacman -S bun; elsewhere: https://bun.sh)"
command -v uv >/dev/null 2>&1 || fail "uv is required for the managed MLflow (Arch: pacman -S uv)"
command -v git >/dev/null 2>&1 || fail "git is required"
"$bun" -e 'const [a,b,c]=Bun.version.split(".").map(Number);process.exit(a>1||(a===1&&(b>4||(b===4&&c>=4)))?0:1)' \
  || fail "bun $("$bun" --version) is older than 1.4.4"
command -v systemctl >/dev/null 2>&1 \
  || echo "note: no systemctl; run the coordinator with: ablationkit coordinator start --foreground"

here=$(cd "$(dirname "$0")" && pwd)
src="$here"
tmp=""
if [ ! -f "$here/lib/ablationkit/package.json" ]; then
  # A source checkout: stage a release from it first.
  root=$(cd "$here/../.." && pwd)
  [ -f "$root/scripts/package.ts" ] || fail "run this from an unpacked release or a source checkout"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  echo "staging a release from $root"
  (cd "$root" && "$bun" install --frozen-lockfile --silent && "$bun" scripts/package.ts --out "$tmp/stage")
  src="$tmp/stage"
fi

version=$(AK_PKG="$src/lib/ablationkit/package.json" "$bun" -e \
  'console.log(JSON.parse(require("fs").readFileSync(process.env.AK_PKG, "utf8")).version)')
dest="$base/$version"
mkdir -p "$base" "$bindir" "$apps" "$icons"
previous=""
[ -L "$base/current" ] && previous=$(readlink "$base/current")

rm -rf "$dest.new"
cp -a "$src" "$dest.new"
rm -f "$dest.new/install.sh"
rm -rf "$dest"
mv "$dest.new" "$dest"
ln -sfn "$version" "$base/current"

# Keep the version just replaced; drop any older ones.
for d in "$base"/*/; do
  n=$(basename "$d")
  [ "$n" = "$version" ] || [ "$n" = "$previous" ] || [ "$n" = "current" ] || rm -rf "$d"
done

ln -sfn "$base/current/bin/ablationkit" "$bindir/ablationkit"
ln -sfn "$base/current/bin/ablationkit-desktop" "$bindir/ablationkit-desktop"
cp "$dest/share/icons/hicolor/scalable/apps/ablationkit.svg" "$icons/ablationkit.svg"
# A desktop session's PATH may not have bun (mise, ~/.bun): name it and the launcher in full.
sed "s|^Exec=.*|Exec=env ABLATIONKIT_BUN=$bun $bindir/ablationkit-desktop|" \
  "$dest/share/applications/ablationkit.desktop" > "$apps/ablationkit.desktop"

echo "installed AblationKit $version in $dest"
case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "add $bindir to PATH to run ablationkit" ;;
esac
if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
  echo "upgraded from $previous: run 'ablationkit coordinator restart' so the service runs $version"
else
  echo "next: ablationkit coordinator start && ablationkit ui"
fi
