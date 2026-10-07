const invoke = (command, args) =>
  window.__TAURI_INTERNALS__.invoke(command, args);
const launcher = document.body.dataset.launcher === "true";
document.getElementById("connection-shell").innerHTML = `
  <aside><div class="brand"><img src="icon.svg" alt=""><span>Cezarion<small>Your coding workspace</small></span></div>
    <div class="section-label">CONNECTIONS</div><nav id="saved" aria-label="Saved connections"></nav>
    <button id="new-connection" class="nav-button"><span aria-hidden="true">＋</span> Add connection</button>
    <div class="sidebar-bottom">${launcher ? '<button id="local-start" class="nav-button"><span aria-hidden="true">⌘</span> Local cockpit <span class="arrow">↗</span></button><p>Run agents on this computer</p>' : "<p>Connections stay on this computer.</p>"}</div>
  </aside>
  <main id="start-options"><header><span class="eyebrow">WORKSPACE / CONNECTIONS</span><span class="badge">DESKTOP</span></header>
    <div class="editor"><div class="connection-icon" aria-hidden="true">↗</div><h1 id="connection-title">Connect your cockpit</h1><p class="intro">Your projects, agents and tasks. Wherever you run them.</p>
      <form id="connect"><label for="endpoint">Cockpit address</label><input id="endpoint" type="url" required placeholder="https://cezarion.example.com" autocomplete="url" spellcheck="false" autocapitalize="none"><p class="hint">HTTPS, or a loopback address for an SSH tunnel.</p>
        <label for="sign-in-origin">Trusted sign-in origin <span>Optional</span></label><input id="sign-in-origin" type="url" placeholder="https://auth.example.com" autocomplete="off" spellcheck="false" autocapitalize="none"><p class="hint">Using Authelia or SSO? Add the HTTPS origin of your sign-in provider.</p>
        <label class="remember"><input id="remember" type="checkbox" checked><span>Remember this connection and sign-in<small id="session-hint">Stay signed in until your server expires the session.</small></span></label>
        <p id="error" role="alert"></p><div class="form-actions"><button class="primary" id="connect-button">Connect <span aria-hidden="true">↗</span></button><button type="button" id="forget" class="quiet hidden">Forget connection…</button></div>
      </form><footer><span class="shield" aria-hidden="true">◇</span> Remote pages cannot access native app commands.<br>Passwords are handled by your sign-in provider.</footer>
    </div>
  </main>
  <dialog id="forget-dialog"><h2>Forget this connection?</h2><p>This closes its window and clears its saved sign-in and browser data on this computer.</p><div class="form-actions"><button id="cancel-forget">Cancel</button><button id="confirm-forget" class="primary">Forget and sign out</button></div></dialog>`;
const endpoint = document.getElementById("endpoint");
const signIn = document.getElementById("sign-in-origin");
const remember = document.getElementById("remember");
const error = document.getElementById("error");
let entries = [];
let selected = null;
function select(entry) {
  window.connectionFeedback = null;
  selected = entry;
  endpoint.value = entry?.endpoint || "";
  signIn.value = entry?.signInOrigin || "";
  remember.checked = true;
  error.textContent = "";
  document.getElementById("forget").classList.toggle("hidden", !entry);
  document.getElementById("connection-title").textContent = entry
    ? "Welcome back"
    : "Connect your cockpit";
  document.getElementById("connect-button").textContent = entry
    ? "Open cockpit ↗"
    : "Connect ↗";
  renderSaved();
}
function renderSaved() {
  const nav = document.getElementById("saved");
  nav.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Your saved cockpits will appear here.";
    nav.append(empty);
  }
  for (const entry of entries) {
    const button = document.createElement("button");
    button.className = "saved-connection";
    button.setAttribute("aria-pressed", String(selected?.id === entry.id));
    const icon = document.createElement("span");
    icon.className = "server-icon";
    icon.textContent = "◫";
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "saved-label";
    label.textContent = new URL(entry.endpoint).hostname;
    const detail = document.createElement("small");
    detail.textContent = new URL(entry.endpoint).port
      ? "Port " + new URL(entry.endpoint).port
      : "Remote cockpit";
    label.append(detail);
    button.append(icon, label);
    button.title = entry.endpoint;
    button.onclick = () => select(entry);
    nav.append(button);
  }
}
async function refresh(initial = false) {
  const result = await invoke("list_connections");
  entries = result.connections;
  if (!result.persistentSessions) {
    document.getElementById("session-hint").textContent =
      "Addresses are saved. Keeping sign-in requires macOS 14 or later.";
  }
  if (initial && !window.connectionFeedback && !endpoint.value)
    select(entries[0] || null);
  else renderSaved();
}
document.getElementById("new-connection").onclick = () => {
  select(null);
  endpoint.focus();
};
document.getElementById("connect").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.getElementById("connect-button");
  button.disabled = true;
  error.textContent = "";
  try {
    await invoke("connect_remote", {
      endpoint: endpoint.value,
      signInOrigin: signIn.value || null,
      remember: remember.checked,
    });
    await refresh();
    const saved = entries.find(
      (e) =>
        new URL(e.endpoint).href === new URL(endpoint.value).href &&
        (e.signInOrigin || "") ===
          (signIn.value ? new URL(signIn.value).href : ""),
    );
    if (saved && remember.checked && !window.connectionFeedback) select(saved);
  } catch (message) {
    error.textContent = String(message);
  } finally {
    button.disabled = false;
  }
});
const dialog = document.getElementById("forget-dialog");
document.getElementById("forget").onclick = () => dialog.showModal();
document.getElementById("cancel-forget").onclick = () => dialog.close();
document.getElementById("confirm-forget").onclick = async () => {
  const button = document.getElementById("confirm-forget");
  button.disabled = true;
  try {
    await invoke("forget_connection", { id: selected.id });
    select(null);
    await refresh();
  } catch (message) {
    error.textContent = String(message);
  } finally {
    button.disabled = false;
    dialog.close();
  }
};
refresh(true).catch((message) => {
  error.textContent = String(message);
});

window.addEventListener("focus", () =>
  refresh()
    .then(() => {
      if (selected && !entries.some((entry) => entry.id === selected.id))
        select(null);
    })
    .catch((message) => {
      error.textContent = String(message);
    }),
);

function clearSelection() {
  selected = null;
  document.getElementById("forget").classList.add("hidden");
  document.getElementById("connection-title").textContent =
    "Connect your cockpit";
  document.getElementById("connect-button").textContent = "Connect ↗";
  renderSaved();
}
for (const input of [endpoint, signIn])
  input.addEventListener("input", () => {
    window.connectionFeedback = null;
    error.textContent = "";
    clearSelection();
  });
document.addEventListener("connection-feedback", clearSelection);
