// Open API Scout — page UI: directory browser, agent chat, BYOK settings,
// consent cards, and the offline (no-key) demo tools.

import { createRuntime, PROVIDER_PRESETS, loadProfile, saveProfile, deleteProfile, testConnection } from "./runtime.js";
import { ACTIONS, loadDirectory } from "./actions.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  runtime: null,
  directory: null,
  profile: loadProfile(),
  pendingConsent: null,
  busy: false,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function logEvent(type, detail) {
  const list = $("#activity-log");
  if (!list) return;
  const item = el("li", "activity-item");
  const time = new Date().toLocaleTimeString();
  item.textContent = `${time} · ${type}${detail?.agent ? ` · ${detail.agent}` : ""}${detail?.name ? ` · ${detail.name}` : ""}${detail?.message ? ` · ${detail.message}` : ""}`;
  list.prepend(item);
  while (list.children.length > 40) list.lastChild.remove();
}

// ---- Consent card (spec: identify destination + purpose before contact) ----

function confirmExternal(request) {
  return new Promise((resolve) => {
    const card = $("#consent-card");
    $("#consent-title").textContent =
      request.kind === "peer-network" ? "Load a peer agent network?" : "Call a public API?";
    $("#consent-body").textContent =
      request.kind === "peer-network"
        ? `The agents want to load the network "${request.apiName}" from ${request.origin} and run it here in your browser, on your own LLM key. Your key is never sent to that site.`
        : `The agents want to fetch live data from ${request.apiName || "a public API"} at ${request.url}. This is a read-only GET request. No key or personal data is sent.`;
    card.hidden = false;
    state.pendingConsent = resolve;
    $("#consent-allow").focus();
  });
}

function settleConsent(approved) {
  $("#consent-card").hidden = true;
  if (state.pendingConsent) state.pendingConsent(approved);
  state.pendingConsent = null;
}

// ---- Directory ---------------------------------------------------------------

function renderDirectory(filter = "") {
  const grid = $("#directory-grid");
  grid.innerHTML = "";
  const q = filter.toLowerCase();
  const apis = state.directory.apis.filter(
    (a) => !q || [a.name, a.category, a.description].join(" ").toLowerCase().includes(q)
  );
  $("#directory-count").textContent = `${apis.length} of ${state.directory.apis.length} APIs`;
  for (const api of apis) {
    const card = el("article", "api-card");
    card.append(el("h3", null, api.name));
    const meta = el("p", "api-meta", `${api.category} · ${api.method} · auth: ${api.auth} · CORS: ${api.cors ? "yes" : "no"}`);
    card.append(meta, el("p", null, api.description));
    const code = el("code", "endpoint", api.endpointTemplate);
    card.append(code);
    const actions = el("div", "api-actions");
    const tryBtn = el("button", "btn btn-small", "Try it live");
    tryBtn.type = "button";
    tryBtn.addEventListener("click", () => tryApi(api));
    const askBtn = el("button", "btn btn-small btn-ghost", "Ask the agents");
    askBtn.type = "button";
    askBtn.addEventListener("click", () => {
      $("#chat-input").value = `Use ${api.name} to get live data. ${api.agentUse}`;
      $("#chat-input").focus();
    });
    actions.append(tryBtn, askBtn);
    card.append(actions);
    grid.append(card);
  }
}

async function tryApi(api) {
  const out = $("#live-output");
  out.textContent = `Calling ${api.name}…`;
  try {
    const prepared = await ACTIONS.call_public_api.prepare({ id: api.id, params: {} });
    const approved = await confirmExternal({ kind: "external-fetch", url: prepared.url, apiName: prepared.apiName });
    if (!approved) {
      out.textContent = "Cancelled — no request was sent.";
      return;
    }
    const result = await ACTIONS.call_public_api.handler({ id: api.id }, prepared);
    out.textContent = JSON.stringify(result, null, 2).slice(0, 6000);
    logEvent("live-call", { name: api.id });
  } catch (err) {
    out.textContent = `Failed: ${err.message}`;
  }
}

// ---- Chat --------------------------------------------------------------------

function addMessage(role, text) {
  const log = $("#chat-log");
  const wrap = el("div", `msg msg-${role}`);
  wrap.append(el("div", "msg-role", role === "user" ? "You" : role === "agent" ? "Open API Scout agents" : "System"));
  const body = el("div", "msg-body");
  body.textContent = text;
  wrap.append(body);
  log.append(wrap);
  wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return wrap;
}

async function sendChat(text) {
  if (state.busy) return;
  state.busy = true;
  $("#chat-send").disabled = true;
  addMessage("user", text);
  const thinking = addMessage("system", "Agents are working… (watch the activity log)");
  try {
    const { answer, modelCalls } = await state.runtime.runTurn(text, state.profile);
    thinking.remove();
    addMessage("agent", answer);
    logEvent("turn-complete", { name: `${modelCalls} model calls` });
  } catch (err) {
    thinking.remove();
    addMessage("system", `Could not complete that request: ${err.message}`);
  } finally {
    state.busy = false;
    $("#chat-send").disabled = false;
  }
}

// Offline demo: deterministic directory Q&A without any LLM key.
async function offlineAnswer(text) {
  const result = await ACTIONS.search_directory.handler({ query: text, limit: 5 });
  if (!result.results.length) {
    return "Offline demo: no directory API matched those keywords. Try words like weather, papers, country, earthquakes, books, or currency. Configure an LLM key above for full agent reasoning.";
  }
  const lines = result.results.map(
    (r) => `• ${r.name} (${r.category}) — ${r.description}\n  ${r.endpointTemplate}`
  );
  return `Offline demo (no LLM key configured — keyword search only):\n\n${lines.join("\n")}\n\nUse "Try it live" on any card to fetch real data, or add your own LLM key in AI model settings for multi-agent answers.`;
}

// ---- BYOK settings -------------------------------------------------------------

function fillSettings() {
  const p = state.profile;
  $("#provider-select").value = p?.providerId || "otari";
  $("#base-url").value = p?.baseUrl || PROVIDER_PRESETS[0].baseUrl;
  $("#model-name").value = p?.model || PROVIDER_PRESETS[0].model;
  $("#api-key").value = p?.apiKey || "";
  updateKeyStatus();
}

function updateKeyStatus() {
  const p = state.profile;
  $("#key-status").textContent = p?.baseUrl
    ? `Active router: ${p.baseUrl} · model: ${p.model} · key: ${p.apiKey ? "saved in this browser only" : "none (local/public routers may not need one)"}`
    : "No LLM configured yet. The offline demo tools work without a key.";
}

function readSettingsForm() {
  return {
    providerId: $("#provider-select").value,
    baseUrl: $("#base-url").value.trim(),
    model: $("#model-name").value.trim(),
    apiKey: $("#api-key").value.trim(),
  };
}

// ---- Boot ----------------------------------------------------------------------

async function boot() {
  state.runtime = createRuntime({
    onEvent: ({ type, detail }) => logEvent(type, detail),
    confirmExternal,
  });
  try {
    const { manifest, networkEntry } = await state.runtime.init("./agent-manifest.json");
    $("#network-status").textContent = `Network "${networkEntry.name}" loaded · front agent: ${networkEntry.front_man} · ${manifest.networks.length} network(s) published`;
    const samples = $("#sample-queries");
    for (const q of networkEntry.sample_queries || []) {
      const btn = el("button", "chip", q);
      btn.type = "button";
      btn.addEventListener("click", () => {
        $("#chat-input").value = q;
        $("#chat-input").focus();
      });
      samples.append(btn);
    }
  } catch (err) {
    $("#network-status").textContent = `Network failed to load: ${err.message}`;
  }

  state.directory = await loadDirectory();
  renderDirectory();
  $("#directory-filter").addEventListener("input", (e) => renderDirectory(e.target.value));

  const presetSelect = $("#provider-select");
  for (const preset of PROVIDER_PRESETS) {
    const opt = el("option", null, preset.label);
    opt.value = preset.id;
    presetSelect.append(opt);
  }
  presetSelect.addEventListener("change", () => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === presetSelect.value);
    if (preset && preset.id !== "custom") {
      $("#base-url").value = preset.baseUrl;
      $("#model-name").value = preset.model;
    }
  });
  fillSettings();

  $("#settings-save").addEventListener("click", () => {
    state.profile = readSettingsForm();
    saveProfile(state.profile);
    updateKeyStatus();
    addMessage("system", "AI model settings saved in this browser. Your key is only sent to the router you selected.");
  });
  $("#settings-test").addEventListener("click", async () => {
    const profile = readSettingsForm();
    $("#test-status").textContent = "Testing…";
    try {
      const { models, modelListed } = await testConnection(profile);
      $("#test-status").textContent =
        modelListed === false
          ? `Connected, but model "${profile.model}" is not in the router's list (${models.slice(0, 8).join(", ")}…). Pick a listed model.`
          : `Connected. ${models.length} model(s) listed${modelListed ? `; "${profile.model}" is available` : ""}.`;
    } catch (err) {
      $("#test-status").textContent = `Test failed: ${err.message}. Check the URL, key, and that the provider allows browser (CORS) calls.`;
    }
  });
  $("#settings-delete").addEventListener("click", () => {
    deleteProfile();
    state.profile = null;
    $("#api-key").value = "";
    updateKeyStatus();
    addMessage("system", "Saved LLM profile deleted from this browser.");
  });

  $("#consent-allow").addEventListener("click", () => settleConsent(true));
  $("#consent-deny").addEventListener("click", () => settleConsent(false));

  $("#chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#chat-input").value.trim();
    if (!text) return;
    $("#chat-input").value = "";
    if (state.profile?.baseUrl && state.profile?.model) {
      await sendChat(text);
    } else {
      addMessage("user", text);
      addMessage("agent", await offlineAnswer(text));
    }
  });

  $("#peer-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = $("#peer-url").value.trim();
    const inquiry = $("#peer-inquiry").value.trim() || "What can this agent network do?";
    if (!url) return;
    if (!state.profile?.baseUrl) {
      addMessage("system", "Peer networks run on your own LLM key. Configure AI model settings first.");
      return;
    }
    addMessage("user", `Ask peer network ${url}: ${inquiry}`);
    try {
      const result = await state.runtime.runPeerNetwork(url, inquiry, { profile: state.profile, modelCalls: 0 });
      addMessage("agent", result.text || result.error || "Peer returned no text.");
    } catch (err) {
      addMessage("system", `Peer call failed: ${err.message}`);
    }
  });

  addMessage(
    "agent",
    "Welcome to Open API Scout. Ask me to find a free API for a goal, or to fetch and summarize live data. Without an LLM key, I answer with offline directory search; with your own key (AI model settings), four agents — coordinator, API curator, live-data analyst, and verifier — work together in your browser."
  );
}

boot().catch((err) => {
  const status = $("#network-status");
  if (status) status.textContent = `Startup failed: ${err.message}`;
});
