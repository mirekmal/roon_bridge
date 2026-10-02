const test = require("node:test");
const assert = require("node:assert/strict");
const { createMcpServer, PROTOCOL_VERSION } = require("../src/mcp-server");

test("MCP server initializes stateless Streamable HTTP sessions and lists focused tools", async () => {
  const server = createMcpServer({ version: "0.2.56", searchLibrary: async () => ({}), playMusic: async () => ({}) });
  const initialized = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION } });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.body.result.serverInfo.version, "0.2.56");
  const listed = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), ["search_roon_library", "play_roon_library_request"]);
  assert.equal(listed.body.result.tools[0].annotations.readOnlyHint, true);
  assert.equal(listed.body.result.tools[1].annotations.readOnlyHint, false);
});

test("MCP tool calls dispatch arguments and return JSON text results", async () => {
  const calls = [];
  const server = createMcpServer({
    searchLibrary: async (args) => { calls.push(["search", args]); return { matches: [{ title: "Animals" }] }; },
    playMusic: async (args) => { calls.push(["play", args]); return { status: "played" }; },
  });
  const searched = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_roon_library", arguments: { artist: "Pink Floyd" } } });
  const played = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "play_roon_library_request", arguments: { artist: "Pink Floyd" } } });
  assert.deepEqual(calls, [["search", { artist: "Pink Floyd" }], ["play", { artist: "Pink Floyd" }]]);
  assert.deepEqual(JSON.parse(searched.body.result.content[0].text), { matches: [{ title: "Animals" }] });
  assert.deepEqual(JSON.parse(played.body.result.content[0].text), { status: "played" });
});

test("MCP reports unknown tools and invalid JSON-RPC methods safely", async () => {
  const server = createMcpServer({ searchLibrary: async () => ({}), playMusic: async () => ({}) });
  const unknownTool = await server.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "not_a_tool" } });
  const unknownMethod = await server.handle({ jsonrpc: "2.0", id: 6, method: "not/a/method" });
  assert.equal(unknownTool.body.result.isError, true);
  assert.match(unknownTool.body.result.content[0].text, /Unknown tool/);
  assert.equal(unknownMethod.body.error.code, -32601);
});

test("MCP initialized notification returns an empty accepted response", async () => {
  const server = createMcpServer({ searchLibrary: async () => ({}), playMusic: async () => ({}) });
  const result = await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.deepEqual(result, { status: 202, body: null });
});
