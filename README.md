# Open API Scout — Agent-Ready Public Data Workbench

An entry for the [Open Agentic Web Challenge](https://cognizant-agenticweb.devpost.com/) (Cognizant AI Lab · Mozilla · NANDA · AWS · UT Austin · AI Commons), built to the [Minimum Viable Specification for a Worldwide Agentic Web, MVP Profile 0.3](https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/worldwide_agentic_web_mvp_spec.md).

**Submission deadline:** 11 Jan 2027, 08:00 Pacific (23:00 WIB). **Prize pool:** $10,000 (1st $5,000 + $1,500 Otari credits, 2nd $3,000 + $750, 3rd $2,000 + $500).

## Concept

Most "agent-ready" demos agentify one business (a pizza menu, a guesthouse). Open API Scout agentifies a *capability every agent needs*: finding and using free public data.

The site publishes:

1. A **curated directory of 18 free, no-key, CORS-enabled public APIs** (weather, geocoding, Wikipedia, Datamuse word finder, Hacker News, OpenAlex, Crossref, World Bank, FX rates, USGS earthquakes, Open Library, GitHub search, ISS position, trivia, PokeAPI, and smoke-test APIs) as machine-readable `api-directory.json` with endpoint templates, example parameters, auth/CORS notes, and per-API agent guidance.
2. A **four-agent network** (`open_api_scout`) that runs entirely in the visitor's browser:
   - `scout_coordinator` (front agent) — understands the goal and delegates.
   - `api_curator` — recommends APIs *only* from the published directory.
   - `live_data_analyst` — calls allowlisted APIs live (GET only, after the visitor approves the destination) and summarizes what came back.
   - `verifier` — checks draft claims against the fetched evidence before anything is presented as fact.
3. A **browser runtime** (`runtime.js`) that loads the manifest, validates the network graph before any model call, executes agents with bounded steps/depth/time, dispatches site actions with consent cards, and can load peer networks by URL (exact-name match, caller's router and key, private context never forwarded).
4. A **BYOK settings panel**: the visitor picks any OpenAI-compatible router (Otari by default, plus OpenAI, OpenRouter, Anthropic, local Ollama, or custom), pastes their own key, tests the connection against `GET /models`, and can delete the saved profile. Keys live only in origin-scoped `localStorage` and are sent only to the selected router.
5. A **no-key offline mode**: without any key, the chat still answers with deterministic directory search and every API card can be tried live — so judges (and humans) get real value before configuring anything.

Other agentic websites can call this network the standard way: fetch `agent-manifest.json`, resolve `open_api_scout`, run it locally on their own key. `llms.txt`, JSON-LD structured data, and `.well-known/agent-card.json` make the site discoverable by crawlers and agents alike. Where the browser supports WebMCP (`navigator.modelContext`), the four site actions are also registered as tools.

## How it meets the submission requirements

| Requirement | Where |
| --- | --- |
| Publicly accessible conforming `.json` describing an agent network | `agent-manifest.json` + `open_api_scout.network.json` (Neuro SAN data model: `tools[]` with `name`, `function.description`, `function.parameters`, `instructions`, `tools[]`; `llm_config` hint; `max_execution_seconds`) |
| A `runtime` that runs the network in the browser | `runtime.js` (validation, agent loop with tool calling, delegation, bounded execution, peer loading) + `actions.js` (site-action catalog) |
| An interface for users/agents to interact | `index.html` + `app.js`: chat with sample queries, browsable API directory with live "Try it" calls, peer-network loader, activity log |
| Optional LLM/key configuration interface | "⚙ AI model settings" panel: provider presets, base URL, model, password key field, Test connection, Save, Delete profile |
| Network interacts with the website / other sites | Agents call same-origin site actions (`website_search_directory`, `website_get_api_details`, `website_call_public_api`, `website_analyze_json`); peer networks load by URL with consent; this network is itself loadable by any conforming runtime |

## How it maps to the judging criteria

- **Technological Implementation** — Full MVP Profile 0.3 surface: manifest + resolved network JSON, pre-flight graph validation (duplicate/missing refs, invalid front agent rejected before any model call), OpenAI-compatible tool-calling loop with agent-to-agent delegation, site-action dispatch with argument validation and consent before third-party contact, peer loading per §3.2 (exact-name match, caller-owned router/key, fail-closed), execution budgets (14 model calls/turn, depth 3, 120 s timeout), SSE-tolerant response parsing, WebMCP progressive enhancement. `node validate.mjs` checks every published artifact.
- **Design** — A complete product, not a bare chat box: hero with machine-readable links, searchable directory cards, live-call output viewer, consent dialogs, activity log, sample queries, responsive layout, accessible labels. Works with zero configuration (offline mode) and upgrades gracefully with a key.
- **Potential Impact** — Public APIs are the long tail of the agentic web: thousands of useful endpoints that agents cannot discover or trust today. A portable directory + grounded multi-agent workbench is reusable infrastructure — any site can link to this network, and the directory format + validator are shared tools for the community. The verifier agent directly attacks the hallucination problem that makes agent-fetched data untrustworthy.
- **Quality of the Idea** — Instead of agentifying one storefront, this agentifies *discovery itself*: the network's job is to make other services usable by any agent, with evidence-checked answers. The no-key offline mode and honest `agent-mcp.json` (MCP facade marked unavailable on static hosting rather than faked) reflect a genuine understanding of the spec's trust boundaries.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page: hero, agent chat, BYOK settings, directory, peer loader |
| `styles.css` | Responsive styling, no framework |
| `app.js` | UI wiring: directory rendering, chat, consent cards, settings, offline mode |
| `runtime.js` | Browser runtime: manifest/network loading + validation, LLM loop, delegation, peer loading, WebMCP |
| `actions.js` | Site actions: directory search/details, allowlisted live GET, JSON analysis |
| `agent-manifest.json` | Site manifest (network index, router defaults, peer policy, actions, linking) |
| `open_api_scout.network.json` | Resolved agent network definition (data-only) |
| `api-directory.json` | Grounding data: 18 free public APIs |
| `links.json` | Peer-network link map (empty by default; peer policy is closed) |
| `agent-mcp.json` | MCP facade status (unavailable on static hosting, with reason) |
| `llms.txt` | Plain-text map for agents/crawlers |
| `.well-known/agent-card.json` | Discovery card |
| `validate.mjs` | Artifact validator (`node validate.mjs`) |
| `favicon.svg` | Site icon |

## Run locally

```bash
cd ~/workspace/devpost/agentic-web
python3 -m http.server 8080
# open http://127.0.0.1:8080/
node validate.mjs   # optional: check all published JSON artifacts
```

Then either use the offline tools immediately, or open **⚙ AI model settings**, pick a provider (Otari `https://api.otari.ai/api/v1` + `alibaba/qwen3.8-flash` is the hackathon default), paste a key, **Test connection**, **Save and start**, and ask a sample question.

## Deploy (GitHub Pages)

1. Create a public repository and push this folder's contents to the repo root (or a `docs/` folder).
2. Repo → Settings → Pages → Source: deploy from branch (`main`, root or `/docs`).
3. Wait for the Pages URL, then verify:
   - `https://<user>.github.io/<repo>/agent-manifest.json` returns JSON.
   - `https://<user>.github.io/<repo>/open_api_scout.network.json` returns JSON.
   - The page loads over HTTPS and the network status line reports the network as loaded.
4. GitHub Pages serves `Access-Control-Allow-Origin: *` for static files, so other origins' runtimes can fetch the manifest and network definition (spec §3.4).

Any other static HTTPS host works the same way (Netlify, Vercel static, Cloudflare Pages, S3+CloudFront) as long as JSON files are served with CORS enabled.

## What remains for the Devpost submission

- [ ] Push to a public GitHub repo and enable GitHub Pages (above).
- [ ] Register on Devpost ("Join Hackathon") with the entrant's Devpost account; optionally claim Otari credits.
- [ ] Record a <2-minute demo video (YouTube, public): show the page, a live API call, the consent card, and a BYOK agent answer with citations.
- [ ] Take 2–3 screenshots (hero+chat, directory, settings/consent).
- [ ] Fill the Devpost submission: project URL (Pages URL), text description (adapt this README), video link, screenshots.
- [ ] Keep the site live and free through the judging period (11–18 Jan 2027).

## Notes & limits

- Live calls are GET-only against hosts allowlisted in `api-directory.json`; responses are capped at 512 KB and truncated for model context.
- Some providers rate-limit unauthenticated use (notably GitHub search); the directory entries say so, and failures are reported honestly rather than papered over.
- Model quality matters: pick a model that reliably makes tool calls. If a provider refuses browser (CORS) calls, use Otari/OpenRouter or a local Ollama/LiteLLM instead.
- The published network definition is public by design (spec §2.2) — it contains no keys or private data.
