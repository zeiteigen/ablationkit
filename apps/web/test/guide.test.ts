/** The HTML content stays independent of the application and works as local files. */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const guide = resolve(import.meta.dir, "../../../docs/guide");
const pages = readdirSync(guide).filter((name) => name.endsWith(".html"));

test("guide chapters and assets work offline, with valid links and anchors", () => {
  expect(pages.length).toBeGreaterThanOrEqual(6);
  for (const page of pages) {
    const path = join(guide, page);
    const html = readFileSync(path, "utf8");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('id="content"');
    expect(html).not.toMatch(/<script\b/i);
    for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const [file, anchor] = (href as string).split("#");
      const target = file ? resolve(dirname(path), file) : path;
      expect(target.startsWith(`${guide}/`)).toBe(true);
      expect(existsSync(target)).toBe(true);
      if (anchor) expect(readFileSync(target, "utf8")).toContain(`id="${anchor}"`);
    }
    for (const chapter of pages) expect(html).toContain(`href="${chapter}"`);
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
  }
});
