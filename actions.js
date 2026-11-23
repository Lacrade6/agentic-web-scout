// Open API Scout — website actions.
// Same-origin capabilities registered with the browser runtime. Agents may propose
// calls to these exact catalog entries; the runtime validates arguments and, for
// external fetches, shows the destination to the visitor before anything is sent.

const DIRECTORY_URL = new URL("./api-directory.json", import.meta.url).href;
const MAX_RESPONSE_BYTES = 512 * 1024;

let directoryCache = null;

export async function loadDirectory() {
  if (directoryCache) return directoryCache;
  const res = await fetch(DIRECTORY_URL);
  if (!res.ok) throw new Error(`Could not load api-directory.json (HTTP ${res.status})`);
  directoryCache = await res.json();
  return directoryCache;
}

function scoreEntry(entry, terms) {
  const haystack = [entry.name, entry.category, entry.description, entry.agentUse, entry.responseNotes]
    .join(" ")
    .toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += term.length > 3 ? 2 : 1;
    if (entry.name.toLowerCase().includes(term)) score += 3;
    if (entry.category.toLowerCase() === term) score += 3;
  }
  return score;
}

export const ACTIONS = {
  search_directory: {
    description:
      "Search the site's published directory of free public APIs by keywords or category. Returns matching APIs with endpoint templates and example parameters.",
    effect: "read",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords describing the data needed, e.g. 'weather forecast' or 'research papers'." },
        category: { type: "string", description: "Optional category filter, e.g. Weather, Research, Reference, News, Earth, Books, Code, Finance, Demo." },
        limit: { type: "integer", description: "Maximum results to return (default 5, max 10)." },
      },
      required: ["query"],
    },
    async handler({ query, category, limit = 5 }) {
      const dir = await loadDirectory();
      const terms = String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const n = Math.min(Math.max(1, Number(limit) || 5), 10);
      let pool = dir.apis;
      if (category) pool = pool.filter((a) => a.category.toLowerCase() === String(category).toLowerCase());
      const ranked = pool
        .map((a) => ({ a, s: scoreEntry(a, terms) }))
        .filter((x) => x.s > 0 || terms.length === 0)
        .sort((x, y) => y.s - x.s)
        .slice(0, n)
        .map(({ a }) => ({
          id: a.id,
          name: a.name,
          category: a.category,
          description: a.description,
          endpointTemplate: a.endpointTemplate,
          exampleParams: a.exampleParams,
          auth: a.auth,
          docsUrl: a.docsUrl,
        }));
      return { query, count: ranked.length, results: ranked };
    },
  },

  get_api_details: {
    description: "Get the full directory entry for one API by its id, including response-shape notes and agent usage guidance.",
    effect: "read",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Directory id, e.g. 'open-meteo-forecast'." } },
      required: ["id"],
    },
    async handler({ id }) {
      const dir = await loadDirectory();
      const entry = dir.apis.find((a) => a.id === id);
      if (!entry) return { error: `No directory entry with id '${id}'. Use search_directory first.` };
      return entry;
    },
  },

  call_public_api: {
    description:
      "Fetch live JSON from one allowlisted public API in the directory (GET only). The visitor sees the exact destination URL and approves before the request is sent. Returns a truncated JSON payload plus fetch metadata.",
    effect: "external-read",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Directory id of the API to call." },
        params: {
          type: "object",
          description: "Values for the {placeholders} in the endpoint template, e.g. {\"name\": \"Jakarta\"}.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["id"],
    },
    // The runtime reads this to build the consent card before dispatch.
    async prepare({ id, params = {} }) {
      const dir = await loadDirectory();
      const entry = dir.apis.find((a) => a.id === id);
      if (!entry) throw new Error(`No directory entry with id '${id}'.`);
      let url = entry.endpointTemplate;
      for (const [key, value] of Object.entries({ ...entry.exampleParams, ...params })) {
        url = url.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
      }
      const missing = [...url.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      if (missing.length) throw new Error(`Missing parameters for ${entry.name}: ${missing.join(", ")}`);
      const parsed = new URL(url);
      const allowedHost = new URL(entry.baseUrl).host;
      if (parsed.host !== allowedHost) throw new Error(`Refusing non-allowlisted host: ${parsed.host}`);
      return { url, apiName: entry.name, host: parsed.host };
    },
    async handler(args, prepared) {
      const started = new Date().toISOString();
      const res = await fetch(prepared.url, { headers: { Accept: "application/json" } });
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, status: res.status, url: prepared.url, fetchedAt: started, bodyPreview: text.slice(0, 500) };
      }
      if (text.length > MAX_RESPONSE_BYTES) {
        return {
          ok: true,
          status: res.status,
          url: prepared.url,
          fetchedAt: started,
          truncated: true,
          bodyPreview: text.slice(0, 20000),
          note: `Response was ${text.length} bytes; only a preview is shown. Use analyze_json on a smaller query if possible.`,
        };
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: true, status: res.status, url: prepared.url, fetchedAt: started, bodyPreview: text.slice(0, 2000) };
      }
      return { ok: true, status: res.status, url: prepared.url, fetchedAt: started, data };
    },
  },

  analyze_json: {
    description:
      "Compute simple statistics over a JSON value fetched earlier: counts, min/max/mean for numeric fields, and top values for categorical fields. Runs entirely in the browser.",
    effect: "read",
    parameters: {
      type: "object",
      properties: {
        data: { description: "The JSON value to analyze (object or array)." },
        numericField: { type: "string", description: "Optional dotted path to a numeric field inside array items, e.g. 'properties.mag'." },
        groupField: { type: "string", description: "Optional dotted path to a categorical field to count, e.g. 'category'." },
      },
      required: ["data"],
    },
    async handler({ data, numericField, groupField }) {
      const getPath = (obj, path) => path.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
      const summary = { type: Array.isArray(data) ? "array" : typeof data };
      const items = Array.isArray(data) ? data : data?.features || data?.results || data?.hits || data?.docs || data?.items || null;
      if (Array.isArray(items)) {
        summary.itemCount = items.length;
        if (numericField) {
          const nums = items.map((it) => Number(getPath(it, numericField))).filter((n) => Number.isFinite(n));
          if (nums.length) {
            summary.numeric = {
              field: numericField,
              count: nums.length,
              min: Math.min(...nums),
              max: Math.max(...nums),
              mean: nums.reduce((a, b) => a + b, 0) / nums.length,
            };
          } else summary.numeric = { field: numericField, count: 0, note: "No numeric values found at that path." };
        }
        if (groupField) {
          const counts = {};
          for (const it of items) {
            const v = getPath(it, groupField);
            if (v !== undefined) counts[String(v)] = (counts[String(v)] || 0) + 1;
          }
          summary.groups = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value, count }));
        }
      } else if (data && typeof data === "object") {
        summary.keys = Object.keys(data).slice(0, 30);
      }
      return summary;
    },
  },
};
