/**
 * Research text rendering (ADR 0048): Markdown with LaTeX, and nothing in a record is ever
 * interpreted as HTML or fetched.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, plainExcerpt } from "../src/components/Markdown.tsx";

const html = (text: string, base?: string) =>
  renderToStaticMarkup(<Markdown text={text} base={base} />);

describe("Markdown (ADR 0048)", () => {
  test("headings, emphasis, lists, code and tables render; a record's headings start below the page's", () => {
    const out = html(
      "## Result\n\nThe gap **closed** by `0.04`.\n\n- one\n- two\n\n| Run | BPB |\n|---|---:|\n| a | 1.40 |\n\n```py\nx = 1 < 2\n```",
    );
    expect(out).toContain('<h4 class="md-h2">Result</h4>');
    expect(out).toContain("<strong>closed</strong>");
    expect(out).toContain("<code>0.04</code>");
    expect(out).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain('<td class="num">1.40</td>');
    expect(out).toContain('<pre class="md-code"><code>x = 1 &lt; 2</code></pre>');
  });

  test("mathematics: $…$, \\(…\\), $$…$$ and \\[…\\] become formulas; prices do not", () => {
    const out = html(
      "Loss $L = -\\ln p$ and \\(a^2\\) inline.\n\n$$\n\\mathrm{BPB} = \\frac{L}{B \\ln 2}\n$$\n\n\\[ x_t \\mid x_{<t} \\]\n\nIt costs $5 or $10.",
    );
    expect(out).toContain('<span class="tex" role="math" aria-label="L = -\\ln p"></span>');
    expect(out).toContain('aria-label="a^2"');
    expect(out).toContain(
      '<div class="md-math"><span class="tex display" role="math" aria-label="\\mathrm{BPB} = \\frac{L}{B \\ln 2}"></span></div>',
    );
    expect(out).toContain('aria-label="x_t \\mid x_{&lt;t}"');
    expect(out).toContain("It costs $5 or $10.");
    expect(out.match(/role="math"/g)).toHaveLength(4);
  });

  test("HTML in a record is shown as text, links open only web targets, images are never loaded", () => {
    const out = html(
      "A <b>bold</b> <img src=x onerror=alert(1)> claim.\n\n<script>alert(1)</script>\n\n[ok](https://example.com) [bad](javascript:alert(1)) ![plot](https://example.com/p.png) ![local](file:///etc/passwd)",
    );
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>',
    );
    // The unsafe target is text in a tooltip, never an href.
    expect(out).toContain('<span title="javascript:alert(1)">bad</span>');
    expect(out).not.toContain('href="javascript:');
    expect(out).toContain('<span class="faint">[local]</span>');
  });

  test("record and task IDs in code spans link into the project", () => {
    const out = html(
      "See `hyp-20261111-821fd1` under `task-20261111-ljvjsb`, not `hyp-x`.",
      "/p/lab",
    );
    expect(out).toContain('href="/p/lab/knowledge/r/hyp-20261111-821fd1"');
    expect(out).toContain('href="/p/lab/tasks/task-20261111-ljvjsb"');
    expect(out).toContain("<code>hyp-x</code>");
    expect(html("`hyp-20261111-821fd1`")).not.toContain("href");
  });

  test("an excerpt drops the marks and tables and keeps the words", () => {
    expect(
      plainExcerpt(
        "## Result\n\nThe gap **closed** by `0.04`.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- next",
        80,
      ),
    ).toBe("Result The gap closed by 0.04. next");
    expect(plainExcerpt("x".repeat(300), 10)).toBe(`${"x".repeat(10)}…`);
    expect(plainExcerpt(undefined)).toBe("");
  });
});
