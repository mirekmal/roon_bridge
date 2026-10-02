const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const mqtt = require("mqtt");
const RoonApi = require("node-roon-api");
const RoonApiBrowse = require("node-roon-api-browse");
const RoonApiTransport = require("node-roon-api-transport");
const RoonApiImage = require("node-roon-api-image");
const {
  buildSnapshot,
  currentTrackKey,
  imageCacheName,
  queueContainsCurrent,
  queueItemsFromMessage,
} = require("./queue-state");
const { blurredArtwork, dominantColor } = require("./artwork-color");
const {
  mapAllZones,
  mapRoonMediaPlayers,
  mediaPlayerStatesToRoonEntries,
} = require("./ha-entity-map");
const { createRoonPersistence } = require("./roon-persistence");
const { createRoonBrowse } = require("./roon-browse");
const { createRoonCatalog } = require("./roon-catalog");
const { createMcpServer } = require("./mcp-server");
const { resolveZoneMapping } = require("./zone-target");

const VERSION = process.env.APP_VERSION || "0.2.56";
const API_VERSION = process.env.API_VERSION || "1.57.0";
const PORT = Number(process.env.HTTP_PORT || 8090);
const MAX_QUEUE_ITEMS = Number(process.env.MAX_QUEUE_ITEMS || 50);
const QUEUE_REFRESH_COOLDOWN_MS = 2000;
const BASE_TOPIC = (process.env.MQTT_BASE_TOPIC || "roon/rdashboard").replace(/\/$/, "");
const ZONE_NAME = (process.env.ROON_ZONE || "").trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const ARTWORK_PUBLIC_BASE_URL = (process.env.ARTWORK_PUBLIC_BASE_URL || PUBLIC_BASE_URL).replace(/\/$/, "");
const ARTWORK_CACHE_DIR = process.env.ARTWORK_CACHE_DIR || "";
const HA_API_URL = (process.env.HA_API_URL || "").replace(/\/$/, "");
const HA_API_TOKEN = process.env.HA_API_TOKEN || "";
const HA_ENTITY_REFRESH_MS = Number(process.env.HA_ENTITY_REFRESH_MS || 60_000);
const ROON_CATALOG_REFRESH_MS = Number(process.env.ROON_CATALOG_REFRESH_MS || 24 * 60 * 60 * 1000);
const ROON_CATALOG_FILE = process.env.ROON_CATALOG_FILE
  || path.join(path.dirname(process.env.ROON_STATE_FILE || "/app/config/roonstate.json"), "roon-catalog.json");
const ROON_MUSIC_ENTITY_ID = (process.env.ROON_MUSIC_ENTITY_ID || "").trim();
const ROON_CONTROL_TOKEN = process.env.ROON_CONTROL_TOKEN || "";
const roonPersistence = createRoonPersistence();
const roonCatalog = createRoonCatalog(ROON_CATALOG_FILE);

const log = (...args) => console.log(new Date().toISOString(), ...args);

const mqttClient = mqtt.connect(process.env.MQTT_URL || "mqtt://127.0.0.1:1883", {
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined,
  clientId: process.env.MQTT_CLIENT_ID || `rdashboard-${Math.random().toString(16).slice(2)}`,
  reconnectPeriod: 5000,
  clean: false,
});

const app = {
  core: null,
  browse: null,
  transport: null,
  image: null,
  zoneSubscription: null,
  syncTimer: null,
  syncPromise: null,
  contexts: new Map(),
  mappings: new Map(),
  entityRegistry: null,
  entityRegistryAt: 0,
  mqttReady: false,
  cache: new Map(),
  catalog: roonCatalog,
  roonBrowse: null,
  catalogRefreshTimer: null,
  coreUnpairing: false,
  catalogRefreshPromise: null,
};

const discoveryPrefix = () => process.env.MQTT_DISCOVERY_PREFIX || "homeassistant";
const stateTopic = (mapping) => `${BASE_TOPIC}/${mapping.sensor_id}/state`;
const discoveryTopic = (mapping) => `${discoveryPrefix()}/sensor/${mapping.sensor_id}/config`;
const availabilityTopic = (mapping) => `${BASE_TOPIC}/${mapping.sensor_id}/availability`;

const publish = (topic, payload, retain = true) => {
  if (!app.mqttReady) return;
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  mqttClient.publish(topic, body, { qos: 1, retain }, (error) => {
    if (error) log("MQTT publish failed", topic, error.message);
  });
};

const publishAvailability = (mapping, value) => publish(availabilityTopic(mapping), value);

const publishDiscovery = (mapping) => {
  publish(discoveryTopic(mapping), {
    name: `Roon dashboard - ${mapping.zone.display_name}`,
    object_id: mapping.sensor_id,
    unique_id: `rdashboard_${mapping.entity_id}`,
    state_topic: stateTopic(mapping),
    value_template: "{{ value_json.state }}",
    json_attributes_topic: stateTopic(mapping),
    icon: "mdi:album",
    availability_topic: availabilityTopic(mapping),
    payload_available: "online",
    payload_not_available: "offline",
  });
};

const fetchHaRoonMediaPlayers = async () => {
  if (!HA_API_URL || !HA_API_TOKEN) return null;
  const response = await fetch(`${HA_API_URL}/states`, {
    headers: { Authorization: `Bearer ${HA_API_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Home Assistant media-player state query returned HTTP ${response.status}`);
  const payload = await response.json();
  return mediaPlayerStatesToRoonEntries(payload);
};

const zoneList = () => Object.values(app.transport?._zones || {});

const discoverMappings = async (zones, force = false) => {
  const filteredZones = ZONE_NAME
    ? zones.filter((zone) => zone.display_name === ZONE_NAME)
    : zones;

  if (HA_API_URL && HA_API_TOKEN) {
    if (force || !app.entityRegistry || Date.now() - app.entityRegistryAt >= HA_ENTITY_REFRESH_MS) {
      try {
        app.entityRegistry = await fetchHaRoonMediaPlayers();
        app.entityRegistryAt = Date.now();
        log("Loaded Home Assistant media-player states", app.entityRegistry.length);
      } catch (error) {
        log("Home Assistant entity discovery failed", error.message);
        if (!app.entityRegistry) return mapAllZones(filteredZones);
      }
    }
    return mapRoonMediaPlayers({
      entityRegistry: app.entityRegistry || [],
      zones: filteredZones,
      coreId: app.core?.core_id || "",
    });
  }

  log("Home Assistant entity discovery is not configured; exposing all Roon zones by slug");
  return mapAllZones(filteredZones);
};

const contextFor = (mapping) => {
  const context = app.contexts.get(mapping.zone.zone_id) || {
    mapping,
    zone: mapping.zone,
    queueSubscription: null,
    queueItems: [],
    queueTrackKey: "",
    queueRefreshAt: 0,
    lastCurrent: null,
    previousCurrent: null,
    snapshot: null,
    artworkColors: new Map(),
  };
  context.mapping = mapping;
  context.zone = mapping.zone;
  app.contexts.set(mapping.zone.zone_id, context);
  return context;
};

const precacheSnapshotArtwork = async (context, snapshot) => {
  const keys = [snapshot?.current, snapshot?.previous, snapshot?.next]
    .map((item) => item?.image_key)
    .filter(Boolean);
  // Roon's image service is more reliable when queue artwork is fetched in
  // sequence. Publish again only after all three URLs are warm.
  for (const key of keys) {
    try {
      const image = await getImage(key);
      if (image.dominantColor) context.artworkColors.set(key, image.dominantColor);
    } catch (error) {
      log("Artwork precache failed", key, error.message);
    }
  }
};

const publishSnapshot = (context) => {
  const nextSnapshot = buildSnapshot({
    zone: context.zone,
    queueItems: context.queueItems,
    previousCurrent: context.previousCurrent,
    imageBaseUrl: ARTWORK_PUBLIC_BASE_URL,
    artworkColors: context.artworkColors,
  });

  if (nextSnapshot.current && context.lastCurrent && nextSnapshot.current.id !== context.lastCurrent.id) {
    nextSnapshot.previous = nextSnapshot.previous || context.lastCurrent;
    context.previousCurrent = context.lastCurrent;
  }
  if (nextSnapshot.current) context.lastCurrent = nextSnapshot.current;
  context.snapshot = nextSnapshot;
  publishAvailability(context.mapping, "online");
  publish(stateTopic(context.mapping), nextSnapshot);
  publishDiscovery(context.mapping);
  precacheSnapshotArtwork(context, nextSnapshot).then(() => {
    if (context.snapshot === nextSnapshot) publish(stateTopic(context.mapping), nextSnapshot);
  });
};

const refreshQueue = (context, reason = "queue incomplete") => {
  if (!context.queueSubscription) return;
  if (Date.now() - context.queueRefreshAt < QUEUE_REFRESH_COOLDOWN_MS) return;
  context.queueRefreshAt = Date.now();
  const oldSubscription = context.queueSubscription;
  context.queueSubscription = null;
  oldSubscription.unsubscribe?.(() => {
    if (app.contexts.get(context.zone.zone_id) === context) subscribeQueue(context);
  });
  log("Refreshing queue subscription", context.zone.display_name, reason);
};

function subscribeQueue(context) {
  if (!app.transport || context.queueSubscription) return;
  context.queueSubscription = app.transport.subscribe_queue(context.zone.zone_id, MAX_QUEUE_ITEMS, (response, message) => {
    const items = queueItemsFromMessage(message);
    if (items) context.queueItems = items;
    if (response === "Subscribed" || response === "Changed") {
      log("Queue update", context.zone.display_name, response, `${context.queueItems.length} items`, items ? "payload received" : "retaining previous queue");
      publishSnapshot(context);
      if (response === "Changed" && !queueContainsCurrent(context.queueItems, context.zone)) {
        refreshQueue(context, items ? "queue payload does not contain current track" : "queue delta omitted");
      }
    }
  });
  log("Subscribed to queue", context.zone.display_name, context.zone.zone_id, context.mapping.entity_id);
}

const deactivateContext = (context) => {
  if (!app.coreUnpairing) context.queueSubscription?.unsubscribe?.(() => {});
  context.queueSubscription = null;
  publishAvailability(context.mapping, "offline");
};

const synchronizeZones = async (zones, force = false) => {
  const mappings = await discoverMappings(zones, force);
  const nextMappings = new Map(mappings.map((mapping) => [mapping.zone.zone_id, mapping]));

  for (const [zoneId, context] of app.contexts) {
    if (!nextMappings.has(zoneId)) deactivateContext(context);
  }

  app.mappings = nextMappings;
  for (const mapping of mappings) {
    const context = contextFor(mapping);
    publishSnapshot(context);
    if (!context.queueSubscription) subscribeQueue(context);
    else {
      const trackKey = currentTrackKey(context.zone);
      const trackChanged = Boolean(trackKey && context.queueTrackKey && trackKey !== context.queueTrackKey);
      if (trackChanged) refreshQueue(context, "current track changed");
      else if (!queueContainsCurrent(context.queueItems, context.zone)) refreshQueue(context, "queue does not contain current track");
    }
    context.queueTrackKey = currentTrackKey(context.zone);
  }

  log("Roon media-player mappings", mappings.map((mapping) => `${mapping.entity_id}=${mapping.zone.display_name}`).join(", ") || "none");
};

const requestZoneSync = (zones, force = false) => {
  app.syncPromise = (app.syncPromise || Promise.resolve())
    .then(() => synchronizeZones(zones, force))
    .catch((error) => log("Roon zone synchronization failed", error.message))
    .finally(() => { app.syncPromise = null; });
  return app.syncPromise;
};

const getImage = (imageKey) => new Promise((resolve, reject) => {
  if (!app.image) return reject(new Error("Roon image service is not connected"));
  const cached = app.cache.get(imageKey);
  if (cached && cached.expiresAt > Date.now()) return resolve(cached);
  app.image.get_image(imageKey, {
    scale: "fit",
    width: 700,
    height: 700,
    format: "image/jpeg",
  }, (error, contentType, image) => {
    if (error) return reject(new Error(String(error)));
    const value = {
      contentType: contentType || "image/jpeg",
      image,
      background: blurredArtwork(image),
      dominantColor: dominantColor(image),
      expiresAt: Date.now() + 30 * 60 * 1000,
    };
    app.cache.set(imageKey, value);
    if (ARTWORK_CACHE_DIR) {
      try {
        fs.mkdirSync(ARTWORK_CACHE_DIR, { recursive: true });
        const cacheName = imageCacheName(imageKey);
        fs.writeFileSync(path.join(ARTWORK_CACHE_DIR, `${cacheName}.jpg`), image);
        if (value.background) {
          fs.writeFileSync(path.join(ARTWORK_CACHE_DIR, `${cacheName}.blur.jpg`), value.background);
        }
      } catch (writeError) {
        log("Artwork cache write failed", writeError.message);
      }
    }
    while (app.cache.size > 96) app.cache.delete(app.cache.keys().next().value);
    resolve(value);
  });
});

const refreshCatalog = (reason = "scheduled") => {
  if (app.catalogRefreshPromise) return app.catalogRefreshPromise;
  if (!app.roonBrowse) return Promise.reject(new Error("Roon Browse service is not connected"));
  app.catalogRefreshPromise = app.roonBrowse.refreshAlbums()
    .then((entries) => {
      app.catalog.replace(entries);
      log("Roon library catalog refreshed", reason, `${entries.length} albums`);
      return app.catalog.summary();
    })
    .finally(() => { app.catalogRefreshPromise = null; });
  return app.catalogRefreshPromise;
};

const catalogSearchRequest = (url) => ({
  q: url.searchParams.get("q") || url.searchParams.get("query") || "",
  artist: url.searchParams.get("artist") || "",
  album: url.searchParams.get("album") || "",
  track: url.searchParams.get("track") || "",
});

const readRequestJson = (request) => new Promise((resolve, reject) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 64 * 1024) request.destroy(new Error("Request body too large"));
  });
  request.on("end", () => {
    if (!body.trim()) return resolve({});
    try { resolve(JSON.parse(body)); } catch (error) { reject(new Error(`Invalid JSON: ${error.message}`)); }
  });
  request.on("error", reject);
});

const sendJson = (response, status, payload) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
};

const controlAuthorized = (request) => !ROON_CONTROL_TOKEN || request.headers["x-rdashboard-token"] === ROON_CONTROL_TOKEN;

const refreshCatalogIfStale = async () => {
  const refreshedAt = app.catalog.refreshedAt ? Date.parse(app.catalog.refreshedAt) : 0;
  if (Date.now() - refreshedAt < 30 * 60 * 1000) return app.catalog.summary();
  if (!app.roonBrowse) {
    if (app.catalog.size) return { ...app.catalog.summary(), stale: true };
    throw new Error("Roon is disconnected and no library cache is available");
  }
  const refreshPromise = refreshCatalog("MCP search refresh");
  refreshPromise.catch((error) => log("Roon library catalog refresh failed", error.message));
  return { ...app.catalog.summary(), stale: true, refreshing: true };
};

const searchLibrary = async (args = {}) => {
  const summary = await refreshCatalogIfStale();
  const request = {
    q: args.query || "",
    artist: args.artist || "",
    album: args.album || "",
    track: args.track || "",
  };
  if (!Object.values(request).some(Boolean)) throw new Error("Provide a query, artist, album, or track to search");
  return { ...summary, matches: app.catalog.search(request, args.limit || 10) };
};

const playRoonRequest = async (body = {}) => {
  const mapping = resolveZoneMapping(
    [...app.mappings.values()],
    body.entity_id || body.zone || body.target,
    ROON_MUSIC_ENTITY_ID || ZONE_NAME,
  );
  if (!mapping) return { status: 409, payload: { error: "No matching Roon playback zone" } };
  if (!app.roonBrowse) return { status: 503, payload: { error: "Roon Browse service is not connected" } };
  const requestData = {
    q: body.q || body.query || "",
    artist: body.artist || "",
    album: body.album || "",
    track: body.track || body.title || "",
  };
  let result;
  if (body.similar_to_artist) {
    result = await app.roonBrowse.playSimilarArtists({
      artist: body.similar_to_artist,
      similarArtists: body.similar_artists,
      zoneId: mapping.zone.zone_id,
      catalog: app.catalog,
    });
  } else if (requestData.artist && !requestData.album && !requestData.track && !requestData.q) {
    result = await app.roonBrowse.playArtistCatalog({
      artist: requestData.artist,
      zoneId: mapping.zone.zone_id,
      catalog: app.catalog,
    });
  } else {
    const query = [requestData.artist, requestData.album, requestData.track].filter(Boolean).join(" ") || requestData.q;
    if (!query) return { status: 400, payload: { error: "A music query is required" } };
    result = await app.roonBrowse.searchAndPlay({ query, request: requestData, zoneId: mapping.zone.zone_id, catalog: app.catalog });
  }
  return {
    status: result.status === "played" ? 200 : 404,
    payload: { ...result, target: mapping.zone.display_name, entity_id: mapping.entity_id },
  };
};

const mcpServer = createMcpServer({
  version: VERSION,
  searchLibrary,
  async playMusic(args) {
    const result = await playRoonRequest(args);
    if (result.status === 404 && ["not_found", "ambiguous"].includes(result.payload.status)) return result.payload;
    if (result.status >= 400) throw new Error(result.payload.error || result.payload.status || "Roon playback request failed");
    return result.payload;
  },
});

const attachCore = (core) => {
  app.coreUnpairing = false;
  app.core = core;
  app.browse = core.services.RoonApiBrowse;
  app.transport = core.services.RoonApiTransport;
  app.roonBrowse = createRoonBrowse(app.browse);
  app.image = core.services.RoonApiImage;
  app.zoneSubscription = app.transport.subscribe_zones((response, message) => {
    if (response !== "Subscribed" && response !== "Changed") return;
    // subscribe_zones emits incremental deltas on "Changed". The transport
    // service keeps the authoritative merged map in _zones.
    requestZoneSync(zoneList(), response === "Subscribed");
  });
  app.syncTimer = setInterval(() => requestZoneSync(zoneList(), true), HA_ENTITY_REFRESH_MS);
  app.catalogRefreshTimer = setInterval(() => refreshCatalog("scheduled").catch((error) => log("Roon catalog refresh failed", error.message)), ROON_CATALOG_REFRESH_MS);
  refreshCatalog("core connected").catch((error) => log("Initial Roon catalog refresh failed", error.message));
  log("Connected to Roon Core", core.display_name || core.core_id);
};

const roon = new RoonApi({
  extension_id: process.env.ROON_EXTENSION_ID || "com.mirekmal.rdashboard",
  display_name: process.env.ROON_DISPLAY_NAME || "Rdashboard Queue Bridge",
  display_version: process.env.ROON_DISPLAY_VERSION || VERSION,
  publisher: process.env.ROON_PUBLISHER || "Mirek Malinowski",
  email: process.env.ROON_EMAIL || "local@example.invalid",
  website: process.env.ROON_WEBSITE || "https://github.com/mirekmal/roon_bridge",
  log_level: process.env.ROON_LOG_LEVEL || "none",
  get_persisted_state: roonPersistence.getPersistedState,
  set_persisted_state: roonPersistence.setPersistedState,
  core_paired: attachCore,
  core_unpaired: () => {
    if (app.coreUnpairing) return;
    app.coreUnpairing = true;
    app.core = null;
    app.browse = null;
    app.transport = null;
    app.roonBrowse = null;
    app.image = null;
    app.zoneSubscription = null;
    if (app.syncTimer) clearInterval(app.syncTimer);
    app.syncTimer = null;
    if (app.catalogRefreshTimer) clearInterval(app.catalogRefreshTimer);
    app.catalogRefreshTimer = null;
    for (const context of app.contexts.values()) deactivateContext(context);
    app.contexts.clear();
    app.mappings.clear();
    log("Roon Core disconnected");
  },
});

roon.init_services({ required_services: [RoonApiBrowse, RoonApiTransport, RoonApiImage] });
roon.start_discovery();

mqttClient.on("connect", () => {
  app.mqttReady = true;
  for (const mapping of app.mappings.values()) {
    publishAvailability(mapping, "online");
    publishDiscovery(mapping);
    const context = app.contexts.get(mapping.zone.zone_id);
    if (context?.snapshot) publish(stateTopic(mapping), context.snapshot);
  }
  log("Connected to MQTT");
});
mqttClient.on("close", () => { app.mqttReady = false; });
mqttClient.on("error", (error) => log("MQTT error", error.message));

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/mcp") {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST", "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "MCP endpoint accepts POST requests" }));
      return;
    }
    const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (ROON_CONTROL_TOKEN && request.headers["x-rdashboard-token"] !== ROON_CONTROL_TOKEN && bearer !== ROON_CONTROL_TOKEN) {
      response.writeHead(401, { "content-type": "application/json; charset=utf-8", "www-authenticate": "Bearer" });
      response.end(JSON.stringify({ error: "Invalid bridge control token" }));
      return;
    }
    try {
      const message = await readRequestJson(request);
      const result = await mcpServer.handle(message);
      if (result.body === null) {
        response.writeHead(result.status, { "cache-control": "no-store" });
        response.end();
      } else {
        response.writeHead(result.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(result.body));
      }
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${error.message}` } }));
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/roon/catalog") {
    sendJson(response, 200, { ...app.catalog.summary(), entries: app.catalog.entries() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/roon/catalog/search") {
    sendJson(response, 200, { ...app.catalog.summary(), matches: app.catalog.search(catalogSearchRequest(url), url.searchParams.get("limit")) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/roon/catalog/refresh") {
    if (!controlAuthorized(request)) return sendJson(response, 401, { error: "Invalid bridge control token" });
    try { return sendJson(response, 200, await refreshCatalog("api request")); }
    catch (error) { return sendJson(response, 503, { error: error.message }); }
  }
  if (request.method === "POST" && url.pathname === "/api/roon/play") {
    if (!controlAuthorized(request)) return sendJson(response, 401, { error: "Invalid bridge control token" });
    try {
      const body = await readRequestJson(request);
      const result = await playRoonRequest(body);
      return sendJson(response, result.status, result.payload);
    } catch (error) { return sendJson(response, 502, { error: error.message }); }
  }
  if (url.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      status: "ok",
      app_version: VERSION,
      api_version: API_VERSION,
      mcp_endpoint: "/mcp",
      mcp_tool_count: mcpServer.tools.length,
      roon_connected: Boolean(app.core),
      mqtt_connected: app.mqttReady,
      catalog: app.catalog.summary(),
      ha_entity_discovery: Boolean(HA_API_URL && HA_API_TOKEN),
      zones: [...app.mappings.values()].map((mapping) => ({
        entity_id: mapping.entity_id,
        queue_entity: mapping.queue_entity,
        zone: mapping.zone.display_name,
        state: app.contexts.get(mapping.zone.zone_id)?.snapshot?.state || "unknown",
      })),
    }));
    return;
  }
  if (url.pathname.startsWith("/image/")) {
    const imageKey = decodeURIComponent(url.pathname.slice("/image/".length));
    try {
      const result = await getImage(imageKey);
      response.writeHead(200, { "content-type": result.contentType, "cache-control": "public, max-age=1800" });
      response.end(result.image);
    } catch (error) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end(`Artwork unavailable: ${error.message}`);
    }
    return;
  }
  if (url.pathname.startsWith("/background/")) {
    const imageKey = decodeURIComponent(url.pathname.slice("/background/".length));
    try {
      const result = await getImage(imageKey);
      response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=1800" });
      response.end(result.background || result.image);
    } catch (error) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end(`Artwork background unavailable: ${error.message}`);
    }
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => log(`HTTP API listening on ${PORT}`, `API ${API_VERSION}`));

const shutdown = () => {
  if (app.syncTimer) clearInterval(app.syncTimer);
  app.zoneSubscription?.unsubscribe?.(() => {});
  for (const context of app.contexts.values()) context.queueSubscription?.unsubscribe?.(() => {});
  mqttClient.end(false, {}, () => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
