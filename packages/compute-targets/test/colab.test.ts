/** The archive a Colab notebook prints when its download silently does nothing (F21). */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parsePrintedArchive } from "../src/colab.ts";

const bytes = new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 37) % 256));
const sha = createHash("sha256").update(bytes).digest("hex");
const b64 = Buffer.from(bytes).toString("base64");
const block = (body = b64, size = bytes.length, hash = sha) =>
  [
    `-----BEGIN ABLATIONKIT ARCHIVE name=ak-j-1-a1-state.tgz bytes=${size} sha256=${hash}-----`,
    ...(body.match(/.{1,76}/g) ?? []),
    "-----END ABLATIONKIT ARCHIVE-----",
  ].join("\n");

describe("parsePrintedArchive", () => {
  test("decodes the block, ignoring the output around it and copy noise inside it", () => {
    const text = `wrote /content/x.tgz\n${block()
      .split("\n")
      .map((l) => `   ${l}  `)
      .join("\r\n")}\nNo file downloaded? …\n`;
    const a = parsePrintedArchive(text);
    expect(a.name).toBe("ak-j-1-a1-state.tgz");
    expect(a.sha256).toBe(sha);
    expect(Buffer.from(a.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  test("a cut, changed or unmarked copy is refused with a reason", () => {
    expect(() => parsePrintedArchive("just some output")).toThrow("no `-----BEGIN");
    expect(() =>
      parsePrintedArchive(block().replace("-----END ABLATIONKIT ARCHIVE-----", "")),
    ).toThrow("no END marker");
    expect(() => parsePrintedArchive(block(b64.slice(0, 200)))).toThrow(
      "part of the text is missing",
    );
    const flipped = `${b64[0] === "A" ? "B" : "A"}${b64.slice(1)}`;
    expect(() => parsePrintedArchive(block(flipped))).toThrow("SHA-256");
    // The name on the BEGIN line is a plain archive name, never a path.
    expect(() =>
      parsePrintedArchive(block().replace("name=ak-j-1-a1-state.tgz", "name=../../x.tgz")),
    ).toThrow("no `-----BEGIN");
  });
});
