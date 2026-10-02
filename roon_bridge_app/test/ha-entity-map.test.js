const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mapRoonMediaPlayers,
  mediaPlayerStatesToRoonEntries,
  queueSensorId,
  slugify,
} = require("../src/ha-entity-map");

test("maps enabled official Roon media players to matching queue sensors", () => {
  const coreId = "core-123";
  const zones = [
    { zone_id: "apple", display_name: "Apple TV" },
    { zone_id: "google", display_name: "Google Mini" },
    { zone_id: "volumio", display_name: "Volumio Bridge" },
  ];
  const registry = [
    { entity_id: "media_player.apple_tv", platform: "roon", disabled_by: null, unique_id: "roon_core-123_Apple TV" },
    { entity_id: "media_player.google_mini", platform: "roon", disabled_by: null, unique_id: "roon_core-123_Google Mini" },
    { entity_id: "media_player.denon", platform: "roon", disabled_by: "user", unique_id: "roon_core-123_Denon" },
    { entity_id: "sensor.roon_core", platform: "roon", disabled_by: null, unique_id: "roon_core-123_Core" },
  ];

  assert.deepEqual(
    mapRoonMediaPlayers({ entityRegistry: registry, zones, coreId }).map((mapping) => [mapping.entity_id, mapping.queue_entity]),
    [
      ["media_player.apple_tv", "sensor.roon_dashboard_apple_tv"],
      ["media_player.google_mini", "sensor.roon_dashboard_google_mini"],
    ],
  );
});

test("supports slug matching when the registry unique id is unavailable", () => {
  const mappings = mapRoonMediaPlayers({
    entityRegistry: [{ entity_id: "media_player.google_mini", platform: "roon", disabled_by: null }],
    zones: [{ zone_id: "google", display_name: "Google Mini" }],
  });
  assert.equal(mappings[0].zone.zone_id, "google");
});

test("turns Home Assistant media-player states into Roon mapping candidates", () => {
  assert.deepEqual(
    mediaPlayerStatesToRoonEntries([
      { entity_id: "media_player.marantz_sacd_30n", attributes: { friendly_name: "Marantz SACD 30n" } },
      { entity_id: "light.living_room", attributes: { friendly_name: "Living room" } },
    ]),
    [{
      entity_id: "media_player.marantz_sacd_30n",
      platform: "roon",
      disabled_by: null,
      original_name: "Marantz SACD 30n",
    }],
  );
});

test("normalizes queue sensor naming", () => {
  assert.equal(slugify("Marantz SACD 30n"), "marantz_sacd_30n");
  assert.equal(queueSensorId("media_player.google_mini"), "sensor.roon_dashboard_google_mini");
  assert.equal(queueSensorId("sensor.roon_core"), "");
});
