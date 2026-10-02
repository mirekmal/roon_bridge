const normalize = (value) => String(value || "").trim().toLocaleLowerCase("pl-PL");

const resolveZoneMapping = (mappings, target, defaultTarget = "") => {
  const requested = normalize(target || defaultTarget);
  if (!requested) return mappings[0] || null;

  return mappings.find((mapping) => [mapping.entity_id, mapping.zone.zone_id, mapping.zone.display_name]
    .some((value) => normalize(value) === requested)) || null;
};

module.exports = { resolveZoneMapping };
