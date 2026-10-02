const PROTOCOL_VERSION = "2025-03-26";

const TOOLS = [
  {
    name: "search_roon_library",
    title: "Search local Roon library",
    description: "Search the current local Roon library cache for matching albums and their artists. Use this first for broad, partial, or uncertain music requests. Returns a small ranked list; only local Roon library content is included.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text music request, artist, album, track, or style criteria." },
        artist: { type: "string", description: "Optional artist filter." },
        album: { type: "string", description: "Optional album filter." },
        track: { type: "string", description: "Optional track filter." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum matches to return (default 10)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "play_roon_library_request",
    title: "Play music from local Roon library",
    description: "Play a selected local artist, album, or track on a Roon zone. For an artist with no album or track, play all available artist music. For similar-artist requests, provide similar_to_artist and similar_artists; the bridge verifies candidates against the local library before queuing them. Use only after interpreting the user's request and, when needed, searching the library.",
    inputSchema: {
      type: "object",
      properties: {
        artist: { type: "string" },
        album: { type: "string" },
        track: { type: "string" },
        query: { type: "string" },
        target: { type: "string", description: "Optional Home Assistant media_player entity or exact Roon zone name." },
        similar_to_artist: { type: "string" },
        similar_artists: { type: "array", items: { type: "string" }, maxItems: 8 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

const jsonRpc = (id, result) => ({ jsonrpc: "2.0", id, result });
const jsonRpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

const createMcpServer = ({ searchLibrary, playMusic, version = "unknown" }) => {
  const callTool = async (name, args = {}) => {
    if (name === "search_roon_library") return searchLibrary(args);
    if (name === "play_roon_library_request") return playMusic(args);
    throw new Error(`Unknown tool: ${name}`);
  };

  const handle = async (message) => {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return { status: 400, body: jsonRpcError(message?.id ?? null, -32600, "Invalid Request") };
    }
    const { id, method, params = {} } = message;
    if (id === undefined && method.startsWith("notifications/")) return { status: 202, body: null };
    if (method === "initialize") {
      return { status: 200, body: jsonRpc(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "rdashboard-roon-bridge", version },
        instructions: "Search the local Roon library before resolving broad or uncertain requests. Only play or queue music that is present in the local catalog.",
      }) };
    }
    if (method === "ping") return { status: 200, body: jsonRpc(id, {}) };
    if (method === "tools/list") return { status: 200, body: jsonRpc(id, { tools: TOOLS }) };
    if (method === "tools/call") {
      try {
        const result = await callTool(params.name, params.arguments || {});
        return { status: 200, body: jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: false }) };
      } catch (error) {
        return { status: 200, body: jsonRpc(id, { content: [{ type: "text", text: error.message }], isError: true }) };
      }
    }
    return { status: 200, body: jsonRpcError(id ?? null, -32601, `Method not found: ${method}`) };
  };

  return { handle, tools: TOOLS };
};

module.exports = { createMcpServer, PROTOCOL_VERSION };
