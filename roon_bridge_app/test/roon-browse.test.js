const test = require("node:test");
const assert = require("node:assert/strict");
const { createRoonBrowse } = require("../src/roon-browse");
const { createRoonCatalog } = require("../src/roon-catalog");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createFakeBrowse = () => {
  const calls = [];
  let searchLoads = 0;
  return {
    calls,
    browse(options, callback) {
      calls.push({ method: "browse", options });
      if (options.hierarchy === "search" && !options.item_key) {
        return callback(false, { action: "list", list: { level: 0, count: 1 } });
      }
      if (options.item_key === "library-key") {
        return callback(false, { action: "list", list: { level: 1, count: 1 } });
      }
      if (options.item_key === "albums-key") {
        return callback(false, { action: "list", list: { level: 2, count: 1 } });
      }
      if (options.item_key === "album-key") {
        return callback(false, { action: "list", list: { level: 1, count: 2 } });
      }
      if (options.item_key === "play-key") {
        return callback(false, { action: "none" });
      }
      return callback(false, { action: "list", list: { level: 0, count: 1 } });
    },
    load(options, callback) {
      calls.push({ method: "load", options });
      if (options.hierarchy === "search" && options.level === undefined) {
        searchLoads += 1;
        if (searchLoads > 1) {
          return callback(false, { items: [{ title: "Play now", item_key: "play-key", hint: "action" }] });
        }
        return callback(false, { items: [{ title: "Animals", subtitle: "Pink Floyd", item_key: "album-key", hint: "list" }] });
      }
      if (options.hierarchy === "search" && options.level === 1) {
        return callback(false, { items: [{ title: "Play now", item_key: "play-key", hint: "action" }] });
      }
      if (options.level === 2) {
        return callback(false, { items: [{ title: "Animals", subtitle: "Pink Floyd", item_key: "album-key", hint: "list" }], offset: 0, list: { count: 1 } });
      }
      if (options.level === 1) {
        return callback(false, { items: [{ title: "Albums", item_key: "albums-key", hint: "list" }] });
      }
      if (options.level === 1 || options.level === 3) {
        return callback(false, { items: [{ title: "Play now", item_key: "play-key", hint: "action" }] });
      }
      return callback(false, { items: [{ title: "Library", item_key: "library-key", hint: "list" }] });
    },
  };
};

test("loads a paged Roon album list", async () => {
  const fake = createFakeBrowse();
  const browse = createRoonBrowse(fake, { pageSize: 1 });
  const result = await browse.refreshAlbums();
  assert.deepEqual(result, [{
    kind: "album", title: "Animals", artist: "Pink Floyd", album: "Animals", subtitle: "Pink Floyd",
  }]);
  assert.equal(fake.calls.filter((call) => call.method === "load").length, 3);
});

test("resolves a catalog match and executes the current Roon playback action", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rdashboard-roon-browse-"));
  const catalog = createRoonCatalog(path.join(directory, "catalog.json"));
  catalog.replace([{ title: "Animals", subtitle: "Pink Floyd", hint: "list" }]);
  const fake = createFakeBrowse();
  const browse = createRoonBrowse(fake);
  const result = await browse.searchAndPlay({
    query: "Pink Floyd Animals",
    request: { artist: "Pink Floyd", album: "Animals" },
    zoneId: "zone-marantz",
    catalog,
  });
  assert.equal(result.status, "played");
  assert.equal(result.action, "Play now");
  assert.equal(fake.calls.find((call) => call.method === "browse").options.zone_or_output_id, "zone-marantz");
});

const createArtistBrowse = () => {
  const calls = [];
  return {
    calls,
    browse(options, callback) {
      calls.push({ method: "browse", options });
      const levels = {
        "library-key": { level: 1, count: 1 },
        "artists-key": { level: 2, count: 3 },
        "artist-pink": { level: 3, count: 2 },
        "artist-queen": { level: 3, count: 2 },
        "artist-radiohead": { level: 3, count: 2 },
        "action-play": { action: "none" },
        "action-queue": { action: "none" },
      };
      if (options.item_key === "library-key") return callback(false, { action: "list", list: levels[options.item_key] });
      if (options.item_key === "artists-key") return callback(false, { action: "list", list: levels[options.item_key] });
      if (options.item_key?.startsWith("artist-")) return callback(false, { action: "list", list: levels[options.item_key] });
      if (options.item_key?.startsWith("action-")) return callback(false, levels[options.item_key]);
      return callback(false, { action: "list", list: { level: 0, count: 1 } });
    },
    load(options, callback) {
      calls.push({ method: "load", options });
      const lastBrowse = [...calls].reverse().find((call) => call.method === "browse");
      if (options.multi_session_key && options.level === undefined && lastBrowse?.options.item_key?.startsWith("artist-")) return callback(false, { items: [
        { title: "Play now", item_key: "action-play", hint: "action" },
        { title: "Add to queue", item_key: "action-queue", hint: "action" },
      ] });
      if (options.level === undefined) return callback(false, { items: [{ title: "Library", item_key: "library-key" }] });
      if (options.level === 1) return callback(false, { items: [{ title: "Artists", item_key: "artists-key" }] });
      if (options.level === 2) return callback(false, { items: [
        { title: "Pink Floyd", item_key: "artist-pink", hint: "list" },
        { title: "Queen", item_key: "artist-queen", hint: "list" },
        { title: "Radiohead", item_key: "artist-radiohead", hint: "list" },
      ] });
      return callback(false, { items: [] });
    },
  };
};

test("plays the whole local artist when no album or track is specified", async () => {
  const fake = createArtistBrowse();
  const browse = createRoonBrowse(fake);
  const result = await browse.playArtistCatalog({ artist: "Pink Floyd", zoneId: "zone-volumio" });
  assert.equal(result.status, "played");
  assert.equal(result.selected.title, "Pink Floyd");
  assert.equal(result.action, "Play now");
  assert.equal(fake.calls.find((call) => call.options.item_key === "artist-pink").options.zone_or_output_id, "zone-volumio");
});

test("falls back to catalogued albums when Roon Browse omits the artist entry", async () => {
  const calls = [];
  const fake = {
    browse(options, callback) {
      calls.push({ method: "browse", options });
      if (options.item_key === "library-key") return callback(false, { action: "list", list: { level: 1, count: 1 } });
      if (options.item_key === "artists-key") return callback(false, { action: "list", list: { level: 2, count: 0 } });
      if (options.hierarchy === "search" && !options.item_key) return callback(false, { action: "list", list: { level: 0, count: 1 } });
      if (options.item_key?.startsWith("album-")) return callback(false, { action: "list", list: { level: 1, count: 2 } });
      if (options.item_key?.startsWith("action-")) return callback(false, { action: "none" });
      return callback(false, { action: "list", list: { level: 0, count: 1 } });
    },
    load(options, callback) {
      calls.push({ method: "load", options });
      const lastBrowse = [...calls].reverse().find((call) => call.method === "browse");
      if (lastBrowse?.options.item_key?.startsWith("album-")) {
        return callback(false, { items: [
          { title: "Play now", item_key: "action-play", hint: "action" },
          { title: "Add to queue", item_key: "action-queue", hint: "action" },
        ] });
      }
      if (options.hierarchy === "search") {
        const query = lastBrowse?.options.input || "";
        return callback(false, { items: [{
        title: query.includes("Animals") ? "Animals" : "Wish You Were Here",
        subtitle: "Pink Floyd", item_key: query.includes("Animals") ? "album-animals" : "album-wish", hint: "list",
      }] });
      }
      if (options.level === 1) return callback(false, { items: [{ title: "Artists", item_key: "artists-key", hint: "list" }] });
      if (options.level === 2) return callback(false, { items: [] });
      return callback(false, { items: [{ title: "Library", item_key: "library-key", hint: "list" }] });
    },
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rdashboard-roon-fallback-"));
  const catalog = createRoonCatalog(path.join(directory, "catalog.json"));
  catalog.replace([
    { kind: "album", title: "Animals", album: "Animals", artist: "Pink Floyd" },
    { kind: "album", title: "Wish You Were Here", album: "Wish You Were Here", artist: "Pink Floyd" },
  ]);
  const browse = createRoonBrowse(fake);
  const result = await browse.playArtistCatalog({ artist: "Pink Floyd", zoneId: "zone-volumio", catalog });
  assert.equal(result.status, "played");
  assert.equal(result.queued.length, 2);
  assert.equal(result.queued[0].action, "Play now");
  assert.equal(result.queued[1].action, "Add to queue");
  assert.equal(calls.filter((call) => call.method === "browse" && call.options.item_key?.startsWith("album-")).length, 2);
});

test("queues only library artists for a similar-artist request", async () => {
  const fake = createArtistBrowse();
  const browse = createRoonBrowse(fake);
  const result = await browse.playSimilarArtists({
    artist: "Pink Floyd",
    similarArtists: ["Queen", "Radiohead", "Not In Library"],
    zoneId: "zone-volumio",
  });
  assert.equal(result.status, "played");
  assert.deepEqual(result.selected.similar_artists, ["Queen", "Radiohead"]);
  assert.deepEqual(result.matches, ["Not In Library"]);
  assert.equal(result.queued[0].action, "Play now");
  assert.equal(result.queued[1].action, "Add to queue");
});
