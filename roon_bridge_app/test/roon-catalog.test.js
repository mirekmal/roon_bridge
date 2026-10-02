const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRoonCatalog, normalizeText } = require("../src/roon-catalog");

test("normalizes Polish diacritics and Roon catalog text", () => {
  assert.equal(normalizeText("Żółta Łódź"), "zolta lodz");
});

test("persists and searches a metadata catalog without session item keys", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rdashboard-roon-catalog-"));
  const file = path.join(directory, "catalog.json");
  const catalog = createRoonCatalog(file, () => new Date("2026-09-30T12:00:00Z"));
  catalog.replace([
    { title: "Animals", subtitle: "Pink Floyd", hint: "list", item_key: "session-key-1" },
    { title: "The Wall", subtitle: "Pink Floyd", hint: "list", item_key: "session-key-2" },
  ]);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.entries.length, 2);
  assert.equal(Object.hasOwn(stored.entries[0], "item_key"), false);
  assert.equal(catalog.search({ artist: "Pink Flojd", album: "Animals" })[0].title, "Animals");
  assert.equal(catalog.summary().refreshed_at, "2026-09-30T12:00:00.000Z");
});
