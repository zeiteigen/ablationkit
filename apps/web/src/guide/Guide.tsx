/** Portable HTML guide renderer. Its only runtime dependency is React, not the app shell. */
import { useEffect, useMemo, useRef } from "react";
import "../../../../docs/guide/guide.css";
import experiments from "../../../../docs/guide/experiments.html" with { type: "text" };
import gettingStarted from "../../../../docs/guide/getting-started.html" with { type: "text" };
import overview from "../../../../docs/guide/index.html" with { type: "text" };
import llm from "../../../../docs/guide/llm.html" with { type: "text" };
import operations from "../../../../docs/guide/operations.html" with { type: "text" };
import reading from "../../../../docs/guide/reading.html" with { type: "text" };

// Bun loads these imports as text; its ambient HTML type describes HTML bundles instead.
const chapters = {
  index: overview,
  "getting-started": gettingStarted,
  reading,
  experiments,
  llm,
  operations,
} as unknown as Record<string, string>;

export function Guide(props: {
  chapter: string;
  hrefFor: (chapter: string) => string;
  onNavigate: (href: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const source = Object.hasOwn(chapters, props.chapter) ? chapters[props.chapter] : undefined;
  const html = useMemo(
    () =>
      source
        ?.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1]
        ?.replace(/<header>[\s\S]*?<\/header>/, "")
        .replace(/<main\b/g, "<article")
        .replace(/<\/main>/g, "</article>")
        .replace(
          /href="([a-z-]+)\.html(#[^"]*)?"/g,
          (_match, chapter, hash) => `href="${props.hrefFor(chapter)}${hash ?? ""}"`,
        ),
    [source, props.hrefFor],
  );
  useEffect(() => {
    if (!html) return;
    const hash = window.location.hash.slice(1);
    if (hash) {
      const target = Array.from(ref.current?.querySelectorAll("[id]") ?? []).find(
        (el) => el.id === hash,
      );
      target?.scrollIntoView();
    }
  }, [html]);
  useEffect(() => {
    const container = ref.current;
    if (!container || !html) return;
    // Delegate native anchor activation, including keyboard activation, to the host router.
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest("a");
      const href = anchor?.getAttribute("href");
      if (!href || (anchor?.target && anchor.target !== "_self")) return;
      if (!Object.keys(chapters).some((chapter) => href.split("#")[0] === props.hrefFor(chapter)))
        return;
      event.preventDefault();
      props.onNavigate(href);
    };
    container.addEventListener("click", click);
    return () => container.removeEventListener("click", click);
  }, [html, props.onNavigate, props.hrefFor]);
  if (!html) return <p>Guide chapter not found.</p>;
  return (
    <div
      className="ak-guide"
      ref={ref}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted bundled HTML authored in docs/guide, never user or research content.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
