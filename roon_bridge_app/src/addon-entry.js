const fs = require("node:fs");

const options = JSON.parse(fs.readFileSync("/data/options.json", "utf8"));
const mqttHost = options.mqtt_host || "core-mosquitto";
const mqttPort = Number(options.mqtt_port || 1883);

process.env.APP_VERSION = "0.2.54";
process.env.API_VERSION = "1.55.0";
process.env.MQTT_URL = `mqtt://${mqttHost}:${mqttPort}`;
process.env.MQTT_USERNAME = options.mqtt_username || "";
process.env.MQTT_PASSWORD = options.mqtt_password || "";
process.env.MQTT_BASE_TOPIC = options.mqtt_base_topic || "roon/rdashboard";
process.env.MQTT_DISCOVERY_PREFIX = options.mqtt_discovery_prefix || "homeassistant";
process.env.HA_API_URL = "http://supervisor/core/api";
process.env.HA_API_TOKEN = process.env.SUPERVISOR_TOKEN || "";
process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${Number(options.http_port || 8090)}`;
process.env.ARTWORK_PUBLIC_BASE_URL = options.public_base_url || "";
process.env.ARTWORK_CACHE_DIR = "/config/www/rdashboard-art";
process.env.HTTP_PORT = String(options.http_port || 8090);
process.env.ROON_MUSIC_ENTITY_ID = options.roon_music_entity_id || "media_player.marantz_sacd_30n";
process.env.ROON_ZONE = options.roon_zone || "";
process.env.ROON_CONTROL_TOKEN = options.roon_control_token || "";
process.env.ROON_STATE_FILE = "/data/roonstate.json";
process.env.ROON_CATALOG_FILE = "/data/roon-catalog.json";

require("/app/src/index.js");
