// Open API Scout — browser runtime for the Open Agentic Web MVP Profile 0.3.
// Loads agent-manifest.json + the resolved .network.json, validates the graph,
// and executes it in the visitor's browser against a visitor-selected
// OpenAI-compatible LLM router (BYOK). No publisher server is involved and the
// visitor's key is only ever sent to the router they selected.

import { ACTIONS } from "./actions.js";

const STORAGE_KEY = "open-api-scout.byok.v1";
const MAX_MODEL_CALLS_PER_TURN = 14;
const MAX_DEPTH = 3;
const TURN_TIMEOUT_MS = 120_000;

export const PROVIDER_PRESETS = [
  { id: "otari", label: "Otari (Mozilla) — hackathon default", baseUrl: "https://api.otari.ai/api/v1", model: "alibaba/qwen3.8-flash" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini" },
  { id: "anthropic", label: "Anthropic (OpenAI-compatible)", baseUrl: "https://api.anthropic.com/v1", model: "claude-haiku-4-5" },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e4b" },
  { id: "custom", label: "Custom OpenAI-compatible endpoint", baseUrl: "", model: "" },
];

export function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

export function saveProfile(profile) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
}

export function deleteProfile() {
  localStorage.removeItem(STORAGE_KEY);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} failed with HTTP ${res.status}`);
  return res.json();
}

// ---- Validation (spec §3.1: reject before any model call) -------------------

export function validateNetwork(network, frontMan) {
  const errors = [];
  if (!network || !Array.isArray(network.tools) || network.tools.length === 0) {
    errors.push("Network has no tools/agents array.");
    return errors;
  }
  const names = new Set();
  for (const agent of network.tools) {
    if (!agent.name) errors.push("An agent is missing its name.");
    else if (names.has(agent.name)) errors.push(`Duplicate agent name: ${agent.name}`);
    else names.add(agent.name);
    if (!agent.function?.description) errors.push(`Agent ${agent.name || "?"} has no function.description.`);
  }
  if (!names.has(frontMan)) errors.push(`Front agent '${frontMan}' is not defined in the network.`);
  for (const agent of network.tools) {
    for (const ref of agent.tools || []) {
      if (typeof ref === "string" && !/^https?:\/\//.test(ref) && !names.has(ref)) {
        errors.push(`Agent ${agent.name} references unknown agent '${ref}'.`);
      }
    }
  }
  return errors;
}

// ---- LLM client (OpenAI-compatible chat completions) ------------------------

async function chatCompletion(profile, messages, tools) {
  const base = profile.baseUrl.replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
  if (base.includes("api.anthropic.com")) headers["anthropic-dangerous-direct-browser-access"] = "true";
  const body = { model: profile.model, messages, temperature: 0.3 };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const res = await fetch(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 400)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Some gateways stream SSE even when not asked; collect delta content.
    const parts = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.message?.content || "";
        if (typeof delta === "string") parts.push(delta);
      } catch { /* ignore partial lines */ }
    }
    if (parts.length) return { role: "assistant", content: parts.join("") };
    throw new Error("LLM returned a response that could not be parsed as JSON or SSE.");
  }
  const message = json.choices?.[0]?.message;
  if (!message) throw new Error("LLM response contained no message.");
  if (Array.isArray(message.content)) {
    message.content = message.content.map((p) => (typeof p === "string" ? p : p.text || "")).join("");
  }
  return message;
}

export async function testConnection(profile) {
  const base = profile.baseUrl.replace(/\/+$/, "");
  const headers = {};
  if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
  if (base.includes("api.anthropic.com")) headers["anthropic-dangerous-direct-browser-access"] = "true";
  const res = await fetch(`${base}/models`, { headers });
  if (!res.ok) throw new Error(`GET /models returned HTTP ${res.status}`);
  const json = await res.json();
  const ids = (json.data || []).map((m) => m.id);
  return { models: ids, modelListed: ids.length === 0 ? null : ids.includes(profile.model) };
}

// ---- Runtime -----------------------------------------------------------------

export function createRuntime({ onEvent = () => {}, confirmExternal = async () => true } = {}) {
  let manifest = null;
  let network = null;
  let networkEntry = null;
  let agentsByName = new Map();
  const history = [];

  const emit = (type, detail) => onEvent({ type, detail, at: new Date().toISOString() });

  async function init(manifestUrl = "./agent-manifest.json") {
    manifest = await fetchJson(new URL(manifestUrl, location.href).href);
    networkEntry = manifest.networks?.[0];
    if (!networkEntry) throw new Error("Manifest lists no networks.");
    const networkUrl = new URL(networkEntry.hocon, new URL(manifestUrl, location.href)).href;
    network = await fetchJson(networkUrl);
    const errors = validateNetwork(network, networkEntry.front_man);
    if (errors.length) throw new Error(`Invalid network: ${errors.join(" ")}`);
    agentsByName = new Map(network.tools.map((a) => [a.name, a]));
    emit("network-loaded", { name: networkEntry.name, frontMan: networkEntry.front_man, agents: [...agentsByName.keys()] });
    registerWebMcpTools();
    return { manifest, network, networkEntry };
  }

  function actionToolSchemas() {
    const allowed = manifest.actions?.agentTools || Object.keys(ACTIONS);
    return allowed
      .filter((name) => ACTIONS[name])
      .map((name) => ({
        type: "function",
        function: {
          name: `website_${name}`,
          description: ACTIONS[name].description,
          parameters: ACTIONS[name].parameters,
        },
      }));
  }

  function agentToolSchemas(agent) {
    const schemas = [];
    for (const ref of agent.tools || []) {
      if (typeof ref === "string" && agentsByName.has(ref)) {
        const target = agentsByName.get(ref);
        schemas.push({
          type: "function",
          function: {
            name: `agent_${ref}`,
            description: target.function.description,
            parameters: target.function.parameters || {
              type: "object",
              properties: { inquiry: { type: "string" } },
              required: ["inquiry"],
            },
          },
        });
      } else if (typeof ref === "string" && /^https?:\/\//.test(ref)) {
        schemas.push({
          type: "function",
          function: {
            name: `peer_${schemas.length}`,
            description: `Call the peer agent network at ${ref} (runs locally in your browser on your own key, after your approval).`,
            parameters: { type: "object", properties: { inquiry: { type: "string" } }, required: ["inquiry"] },
          },
        });
      }
    }
    return schemas;
  }

  async function dispatchAction(name, args) {
    const action = ACTIONS[name];
    if (!action) return { error: `Unknown action '${name}'.` };
    try {
      let prepared = null;
      if (action.prepare) prepared = await action.prepare(args);
      if (action.effect === "external-read") {
        const approved = await confirmExternal({
          kind: "external-fetch",
          origin: prepared ? new URL(prepared.url).origin : "unknown",
          url: prepared?.url,
          apiName: prepared?.apiName,
          args,
        });
        if (!approved) return { error: "The visitor declined the external request. Do not retry it without a new request." };
      }
      emit("action-call", { name, args });
      const result = await action.handler(args, prepared);
      emit("action-result", { name, ok: result?.ok !== false });
      return result;
    } catch (err) {
      emit("action-error", { name, message: String(err.message || err) });
      return { error: String(err.message || err) };
    }
  }

  async function runAgent(agentName, inquiry, ctx, depth) {
    if (depth > MAX_DEPTH) return { error: "Composition depth limit reached." };
    const agent = agentsByName.get(agentName);
    if (!agent) return { error: `Unknown agent '${agentName}'.` };
    if (ctx.modelCalls >= MAX_MODEL_CALLS_PER_TURN) return { error: "Model-call budget for this turn is exhausted." };
    emit("agent-start", { agent: agentName, depth });

    const systemParts = [network.instructions_prefix, agent.instructions].filter(Boolean);
    const messages = [
      { role: "system", content: systemParts.join("\n\n") },
      { role: "user", content: inquiry },
    ];
    const tools = [...agentToolSchemas(agent), ...actionToolSchemas()];

    for (let step = 0; step < 6; step++) {
      if (ctx.modelCalls >= MAX_MODEL_CALLS_PER_TURN) return { error: "Model-call budget for this turn is exhausted." };
      ctx.modelCalls += 1;
      const message = await chatCompletion(ctx.profile, messages, tools);
      messages.push(message);
      const calls = message.tool_calls || [];
      if (!calls.length) {
        emit("agent-done", { agent: agentName });
        return { text: message.content || "" };
      }
      for (const call of calls) {
        const fnName = call.function?.name || "";
        let args = {};
        try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = {}; }
        let result;
        if (fnName.startsWith("website_")) {
          result = await dispatchAction(fnName.slice("website_".length), args);
        } else if (fnName.startsWith("agent_")) {
          const target = fnName.slice("agent_".length);
          emit("delegate", { from: agentName, to: target });
          result = await runAgent(target, args.inquiry || inquiry, ctx, depth + 1);
        } else if (fnName.startsWith("peer_")) {
          result = await runPeerByIndex(agent, fnName, args.inquiry || inquiry, ctx);
        } else {
          result = { error: `Unknown tool '${fnName}'.` };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id || fnName,
          content: JSON.stringify(result).slice(0, 12000),
        });
      }
    }
    return { error: `Agent ${agentName} exceeded its step limit without a final answer.` };
  }

  async function runPeerByIndex(agent, fnName, inquiry, ctx) {
    const peers = (agent.tools || []).filter((r) => typeof r === "string" && /^https?:\/\//.test(r));
    const index = Number(fnName.replace("peer_", ""));
    const peerUrl = peers[index];
    if (!peerUrl) return { error: "Peer reference could not be resolved." };
    return runPeerNetwork(peerUrl, inquiry, ctx);
  }

  // Spec §3.2: load a peer network by URL, exact-name match, run locally.
  async function runPeerNetwork(peerUrl, inquiry, ctx) {
    const url = new URL(peerUrl);
    const networkName = url.pathname.split("/").filter(Boolean).pop();
    const base = peerUrl.slice(0, peerUrl.length - networkName.length);
    const approved = await confirmExternal({ kind: "peer-network", origin: url.origin, url: peerUrl, apiName: networkName });
    if (!approved) return { error: "The visitor declined contact with the peer origin." };
    emit("peer-load", { url: peerUrl });
    const peerManifest = await fetchJson(`${base}agent-manifest.json`);
    const entry = (peerManifest.networks || []).find((n) => n.name === networkName);
    if (!entry) return { error: `Peer manifest has no network named '${networkName}'.` };
    const peerNetwork = await fetchJson(new URL(entry.hocon, `${base}agent-manifest.json`).href);
    const errors = validateNetwork(peerNetwork, entry.front_man);
    if (errors.length) return { error: `Peer network is invalid: ${errors.join(" ")}` };
    const savedAgents = agentsByName;
    const savedNetwork = network;
    agentsByName = new Map(peerNetwork.tools.map((a) => [a.name, a]));
    network = peerNetwork;
    try {
      // The peer inherits the caller's router and key; its own manifest
      // router metadata is informational only and never overrides ours.
      return await runAgent(entry.front_man, inquiry, ctx, 1);
    } finally {
      agentsByName = savedAgents;
      network = savedNetwork;
    }
  }

  async function runTurn(userText, profile) {
    if (!network) throw new Error("Runtime is not initialized.");
    if (!profile?.baseUrl || !profile?.model) {
      throw new Error("No LLM configured. Open AI model settings and save a provider, model, and key — or use the offline demo tools below.");
    }
    const ctx = { profile, modelCalls: 0, startedAt: Date.now() };
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Turn timed out. Partial work was stopped; nothing was retried automatically.")), TURN_TIMEOUT_MS)
    );
    const work = (async () => {
      const front = networkEntry.front_man;
      const result = await runAgent(front, userText, ctx, 0);
      if (result.error) throw new Error(result.error);
      return result.text;
    })();
    const answer = await Promise.race([work, timeout]);
    history.push({ role: "user", content: userText }, { role: "assistant", content: answer });
    return { answer, modelCalls: ctx.modelCalls };
  }

  function registerWebMcpTools() {
    try {
      const mc = navigator.modelContext;
      if (!mc?.registerTool) return;
      for (const [name, action] of Object.entries(ACTIONS)) {
        mc.registerTool({
          name: `open_api_scout_${name}`,
          description: action.description,
          inputSchema: action.parameters,
          execute: async (args) => {
            const prepared = action.prepare ? await action.prepare(args) : null;
            return action.handler(args, prepared);
          },
        });
      }
      emit("webmcp-registered", { tools: Object.keys(ACTIONS).length });
    } catch {
      // WebMCP is progressive enhancement only.
    }
  }

  return { init, runTurn, runPeerNetwork, history, get manifest() { return manifest; }, get network() { return network; } };
}
