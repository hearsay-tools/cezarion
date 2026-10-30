document.getElementById("local-start").onclick = () => {
  window.cezarSplash.set("Starting local cockpit", "Preparing your workspace…");
  window.__TAURI_INTERNALS__
    .invoke("retry_start")
    .catch((message) =>
      window.cezarSplash.fail("Could not start", String(message), ""),
    );
};
window.cezarSplash = {
  set(title, detail) {
    document.getElementById("title").textContent = title;
    document.getElementById("detail").textContent = detail;
    document.getElementById("connection-shell").classList.add("hidden");
    document.getElementById("startup").classList.remove("hidden");
    document.getElementById("spinner").classList.remove("hidden");
  },
  fail(title, detail, log) {
    this.set(title, detail);
    document.getElementById("spinner").classList.add("hidden");
    document.getElementById("connection-shell").classList.remove("hidden");
    document.getElementById("local-start").textContent = "Retry local cockpit";
    document.getElementById("log").textContent = log || "";
    document.getElementById("log").classList.toggle("hidden", !log);
  },
  log(line) {
    const pre = document.getElementById("log");
    pre.classList.remove("hidden");
    pre.textContent += (pre.textContent ? "\n" : "") + line;
    pre.scrollTop = pre.scrollHeight;
  },
};
const params = new URLSearchParams(location.search);
if (params.get("needs_node") || params.get("error")) {
  window.cezarSplash.fail(
    params.get("title") || "Local cockpit unavailable",
    params.get("error") || "",
    params.get("log") || "",
  );
  if (params.get("needs_node"))
    document.getElementById("actions").classList.remove("hidden");
} else if (params.get("title"))
  window.cezarSplash.set(params.get("title"), params.get("detail") || "");
document.getElementById("retry").onclick = () =>
  document.getElementById("local-start").click();
