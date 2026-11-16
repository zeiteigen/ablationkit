import { expect, test } from "bun:test";
import { color256, DEFAULT_BG, DEFAULT_FG, PALETTE, parseAnsi } from "../src/lib/ansi.ts";

const E = "\u001b";

test("plain text is one span per line", () => {
  expect(parseAnsi("hello\nworld")).toEqual([
    [{ text: "hello", style: {} }],
    [{ text: "world", style: {} }],
  ]);
  expect(parseAnsi("")).toEqual([[]]);
});

test("colours, attributes and resets", () => {
  const [line] = parseAnsi(`a${E}[1;31mb${E}[22mc${E}[0md`);
  expect(line).toEqual([
    { text: "a", style: {} },
    { text: "b", style: { color: PALETTE[1] as string, fontWeight: "bold" } },
    { text: "c", style: { color: PALETTE[1] as string } },
    { text: "d", style: {} },
  ]);
  const [bright] = parseAnsi(`${E}[92;104mx`);
  expect(bright?.[0]?.style).toEqual({
    color: PALETTE[10] as string,
    backgroundColor: PALETTE[12] as string,
  });
});

test("256 and 24-bit colours, inverse, styles that run across lines", () => {
  expect(color256(16)).toBe("#000000");
  expect(color256(231)).toBe("#ffffff");
  expect(color256(232)).toBe("#080808");
  expect(color256(300)).toBeUndefined();
  const lines = parseAnsi(`${E}[38;5;196mred\nstill${E}[38;2;1;2;3m rgb${E}[7m inv`);
  expect(lines[0]?.[0]?.style.color).toBe("#ff0000");
  expect(lines[1]?.[0]).toEqual({ text: "still", style: { color: "#ff0000" } });
  expect(lines[1]?.[1]?.style.color).toBe("#010203");
  expect(lines[1]?.[2]?.style).toEqual({ color: DEFAULT_BG, backgroundColor: "#010203" });
  const [def] = parseAnsi(`${E}[7mx`);
  expect(def?.[0]?.style).toEqual({ color: DEFAULT_BG, backgroundColor: DEFAULT_FG });
});

test("other escape sequences and control characters are dropped, never shown", () => {
  const [line] = parseAnsi(`${E}]8;;https://x.example${E}\\link${E}]8;;${E}\\ ${E}[2Kok\u0007`);
  expect(line?.map((s) => s.text).join("")).toBe("link ok");
  // Markup is text: rendered as a text node, never parsed.
  expect(parseAnsi("<b>x</b>")[0]?.[0]?.text).toBe("<b>x</b>");
});
