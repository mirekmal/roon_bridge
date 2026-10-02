const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveZoneMapping } = require("../src/zone-target");

const mappings = [
  { entity_id: "media_player.marantz_sacd_30n", zone: { zone_id: "zone-marantz", display_name: "Marantz SACD 30n" } },
  { entity_id: "media_player.volumio_bridge", zone: { zone_id: "zone-volumio", display_name: "Volumio Bridge" } },
];

test("selects the requested Roon output by Home Assistant entity ID or zone name", () => {
  assert.equal(resolveZoneMapping(mappings, "media_player.volumio_bridge"), mappings[1]);
  assert.equal(resolveZoneMapping(mappings, "Volumio Bridge"), mappings[1]);
});

test("keeps the configured Marantz output as the default", () => {
  assert.equal(resolveZoneMapping(mappings, undefined, "media_player.marantz_sacd_30n"), mappings[0]);
});

test("rejects an unknown requested output", () => {
  assert.equal(resolveZoneMapping(mappings, "media_player.unknown"), null);
});
