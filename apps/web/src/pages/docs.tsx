/** Thin app adapter for the independent HTML guide. No frame, endpoint, or server needed. */
import { Trail } from "../components/ui.tsx";
import { Guide } from "../guide/Guide.tsx";
import { navigate } from "../router.ts";

const hrefFor = (chapter: string) => (chapter === "index" ? "/docs" : `/docs/${chapter}`);

export function DocsPage(props: { path: string }) {
  return (
    <Trail crumbs={[{ label: "Docs" }]}>
      <Guide
        chapter={props.path === "/docs" ? "index" : props.path.slice("/docs/".length)}
        hrefFor={hrefFor}
        onNavigate={navigate}
      />
    </Trail>
  );
}
