// Validate the published agentic-web artifacts in this folder.
// Usage: node validate.mjs   (exit code 0 = all checks pass)
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readJson = async (name) => JSON.parse(await readFile(join(here, name), "utf8"));

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures += 1;
};

const manifest = await readJson("agent-manifest.json");
const entry = manifest.networks?.[0];
check("manifest lists at least one network", Boolean(entry));
check("manifest network has name/front_man/hocon", Boolean(entry?.name && entry?.front_man && entry?.hocon));

const networkFile = entry.hocon.replace(/^\.\//, "");
const network = await readJson(networkFile);
const names = new Set((network.tools || []).map((a) => a.name));
check("network has agents", names.size > 0, `${names.size} agents`);
check("front_man exists in network", names.has(entry.front_man));
check("agent names are unique", names.size === (network.tools || []).length);
for (const agent of network.tools || []) {
  check(`agent ${agent.name} has function.description`, Boolean(agent.function?.description));
  check(`agent ${agent.name} has instructions`, Boolean(agent.instructions));
  for (const ref of agent.tools || []) {
    if (typeof ref === "string" && !/^https?:\/\//.test(ref)) {
      check(`agent ${agent.name} -> ${ref} resolves`, names.has(ref));
    }
  }
}
check("network declares llm_config hint", Boolean(network.llm_config?.model_name), network.llm_config?.model_name || "");
check("network declares max_execution_seconds", Number.isFinite(network.max_execution_seconds));

const directory = await readJson("api-directory.json");
check("directory has APIs", Array.isArray(directory.apis) && directory.apis.length >= 10, `${directory.apis?.length} entries`);
const ids = new Set();
for (const api of directory.apis) {
  check(`api ${api.id} unique id`, !ids.has(api.id));
  ids.add(api.id);
  check(`api ${api.id} is GET + CORS + template`, api.method === "GET" && api.cors === true && Boolean(api.endpointTemplate));
  const host = new URL(api.baseUrl).host;
  check(`api ${api.id} template host matches baseUrl`, new URL(api.endpointTemplate.replace(/\{\w+\}/g, "x")).host === host);
}

const links = await readJson("links.json");
check("links.json version 1", links.version === 1);
const mcp = await readJson("agent-mcp.json");
check("agent-mcp.json honestly reports availability", typeof mcp.available === "boolean");
const card = await readJson(".well-known/agent-card.json");
check("agent card names the site", Boolean(card.name));

const rawManifest = await readFile(join(here, "agent-manifest.json"), "utf8");
const rawNetwork = await readFile(join(here, networkFile), "utf8");
check("no API keys in published JSON", !/sk-[A-Za-z0-9]|otk_v1|Bearer\s+[A-Za-z0-9]/.test(rawManifest + rawNetwork));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
