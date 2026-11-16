// The connection page of the desktop app (ADR 0025). Plain script: it talks to the main process
// only through the three calls the preload exposes.

const desk = window.ablationkitDesktop;
const $ = (id) => document.getElementById(id);

function showError(message) {
  const el = $("error");
  el.textContent = message || "";
  el.hidden = !message;
  $("connect").disabled = false;
  $("connect").textContent = "Connect";
}

function mode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function sync() {
  $("managed").hidden = mode() !== "managed";
  $("remote").hidden = mode() !== "remote";
}

for (const r of document.querySelectorAll('input[name="mode"]')) r.addEventListener("change", sync);

const initial = new URLSearchParams(location.search).get("error");
if (initial) showError(initial);
desk.onError(showError);

void desk.config().then((c) => {
  const cfg = c.config;
  document.querySelector(`input[name="mode"][value="${cfg.mode}"]`).checked = true;
  $("home").value = cfg.home || "";
  $("home").placeholder = c.home;
  $("child").checked = cfg.launch === "child";
  $("remote_url").value = cfg.remote_url || "";
  $("config").textContent = `Saved in ${c.path}`;
  sync();
});

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  showError("");
  $("connect").disabled = true;
  $("connect").textContent = "Connecting…";
  const input =
    mode() === "remote"
      ? { mode: "remote", remote_url: $("remote_url").value.trim(), link: $("link").value.trim() }
      : {
          mode: "managed",
          home: $("home").value.trim(),
          launch: $("child").checked ? "child" : "service",
        };
  desk.connect(input).catch((err) => {
    showError(
      String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""),
    );
  });
});
