const slugify = (value) => String(value || "")
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

const mediaPlayerSuffix = (entityId) => {
  const match = /^media_player\.([a-z0-9_]+)$/.exec(String(entityId || ""));
  return match ? match[1] : "";
};

const queueSensorId = (entityId) => {
  const suffix = mediaPlayerSuffix(entityId);
  return suffix ? `sensor.roon_dashboard_${suffix}` : "";
};

const isEnabledRoonMediaPlayer = (entry) => Boolean(
  entry
  && entry.entity_id?.startsWith("media_player.")
  && entry.platform === "roon"
  && !entry.disabled_by,
);

const mediaPlayerStatesToRoonEntries = (states = []) => Object.values(states || {})
  .filter((state) => state?.entity_id?.startsWith("media_player."))
  .map((state) => ({
    entity_id: state.entity_id,
    platform: "roon",
    disabled_by: null,
    original_name: state.attributes?.friendly_name || "",
  }));

const uniqueIdZoneName = (entry, coreId) => {
  const uniqueId = String(entry?.unique_id || "");
  const prefix = coreId ? `roon_${coreId}_` : "roon_";
  return uniqueId.startsWith(prefix) ? uniqueId.slice(prefix.length) : "";
};

const findZone = (entry, zones, coreId) => {
  const suffix = mediaPlayerSuffix(entry.entity_id);
  const uniqueName = uniqueIdZoneName(entry, coreId);
  const candidates = [uniqueName, entry.original_name, entry.name].filter(Boolean);

  return zones.find((zone) => candidates.includes(zone.display_name))
    || zones.find((zone) => slugify(zone.display_name) === suffix)
    || zones.find((zone) => slugify(zone.display_name) === slugify(uniqueName));
};

const mapRoonMediaPlayers = ({ entityRegistry = [], zones = [], coreId = "" }) => {
  const zoneList = Object.values(zones || {});
  return entityRegistry
    .filter(isEnabledRoonMediaPlayer)
    .map((entry) => {
      const zone = findZone(entry, zoneList, coreId);
      if (!zone) return null;
      return {
        entity_id: entry.entity_id,
        queue_entity: queueSensorId(entry.entity_id),
        sensor_id: `roon_dashboard_${mediaPlayerSuffix(entry.entity_id)}`,
        zone,
      };
    })
    .filter(Boolean);
};

const mapAllZones = (zones = []) => Object.values(zones || {}).map((zone) => {
  const suffix = slugify(zone.display_name);
  return {
    entity_id: `media_player.${suffix}`,
    queue_entity: `sensor.roon_dashboard_${suffix}`,
    sensor_id: `roon_dashboard_${suffix}`,
    zone,
  };
});

module.exports = {
  isEnabledRoonMediaPlayer,
  mediaPlayerStatesToRoonEntries,
  mapAllZones,
  mapRoonMediaPlayers,
  mediaPlayerSuffix,
  queueSensorId,
  slugify,
};
