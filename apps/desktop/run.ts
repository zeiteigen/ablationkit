/**
 * `bun run desktop`: build the shell and open it with the system Electron (ADR 0025). Electron is
 * not downloaded by `bun install`; install it from the distribution (Arch: `pacman -S electron43`)
 * or point ABLATIONKIT_ELECTRON at a binary. `--prebuilt` (the installed `ablationkit-desktop`)
 * opens the shell already in `dist/` instead of building it: an install's tree is read-only.
 */
import { join } from "node:path";
import { buildDesktop } from "./build.ts";
import { findElectron } from "./src/policy.ts";

const electron = findElectron(process.env, (c) => Bun.which(c));
if (!electron) {
  console.error(
    "no Electron found: install it (Arch: pacman -S electron43; elsewhere: npm i -g electron@43) or set ABLATIONKIT_ELECTRON",
  );
  process.exit(1);
}
const args = process.argv.slice(2);
const prebuilt = args[0] === "--prebuilt";
const main = prebuilt ? join(import.meta.dir, "dist", "main.cjs") : await buildDesktop();
const p = Bun.spawn([electron, main, ...(prebuilt ? args.slice(1) : args)], {
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await p.exited);
