import { mount, type RunSummary } from "@ablationkit/extension-sdk";

void mount(async (host, root) => {
  const { runs } = await host.call<{ runs: RunSummary[] }>("runs.list", { limit: 5 });
  root.innerHTML = "";
  const h = document.createElement("strong");
  h.textContent = `${runs.length} recent runs`;
  root.append(h);
  for (const r of runs) {
    const p = document.createElement("div");
    p.textContent = `${r.run_name ?? r.run_id}: ${r.status ?? ""}`;
    root.append(p);
  }
});
