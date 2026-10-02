const crypto = require("node:crypto");

const asNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const firstText = (...values) => values.find((value) => typeof value === "string" && value.trim()) || "";

const queueItemsFromMessage = (message) => {
  if (!message || typeof message !== "object") return null;
  const candidates = [
    message,
    message.data,
    message.body,
    message.queue,
  ].filter((value) => value && typeof value === "object");
  for (const candidate of candidates) {
    for (const key of ["items", "queue_items", "queue"]) {
      if (Array.isArray(candidate[key])) return candidate[key];
    }
  }
  return null;
};

const itemIdentity = (item) => firstText(
  item?.queue_item_id,
  item?.item_id,
  item?.track_key,
  item?.item_key,
  item?.id,
);

const currentTrackKey = (zone) => {
  const nowPlaying = zone?.now_playing;
  return firstText(
    nowPlaying?.queue_item_id,
    nowPlaying?.item_id,
    nowPlaying?.queue_item,
    nowPlaying && JSON.stringify([
      firstText(nowPlaying.three_line?.line1, nowPlaying.two_line?.line1, nowPlaying.one_line?.line1, nowPlaying.title),
      firstText(nowPlaying.three_line?.line2, nowPlaying.artist),
      nowPlaying.image_key || "",
    ]),
  );
};

const queueContainsCurrent = (queueItems, zone) => {
  const nowPlaying = zone?.now_playing;
  if (!nowPlaying) return true;
  if (!Array.isArray(queueItems) || queueItems.length === 0) return false;

  const identities = [
    nowPlaying.queue_item_id,
    nowPlaying.item_id,
    nowPlaying.queue_item,
  ].filter(Boolean).map(String);
  const title = firstText(
    nowPlaying.three_line?.line1,
    nowPlaying.two_line?.line1,
    nowPlaying.one_line?.line1,
    nowPlaying.title,
  );

  return queueItems.some((item) => {
    const identity = itemIdentity(item);
    return (identity && identities.includes(String(identity)))
      || (title
        ? (item.three_line?.line1 || item.two_line?.line1 || item.one_line?.line1 || item.title) === title
          && (!nowPlaying.image_key || item.image_key === nowPlaying.image_key)
        : nowPlaying.image_key && item.image_key === nowPlaying.image_key);
  });
};

const imageCacheName = (imageKey) => crypto.createHash("sha256").update(String(imageKey)).digest("hex");

const normalizeItem = (item, imageBaseUrl = "") => {
  if (!item || typeof item !== "object") return null;
  const lines = item.three_line || item.lines || item.two_line || item.one_line || {};
  const imageKey = firstText(item.image_key, item.imageKey);
  const id = itemIdentity(item) || `${firstText(lines.line1, item.title)}:${imageKey}`;
  const result = {
    id,
    title: firstText(lines.line1, item.title, item.name),
    artist: firstText(lines.line2, item.artist),
    album: firstText(lines.line3, item.album),
    duration: asNumber(item.length ?? item.duration),
    image_key: imageKey,
    is_now_playing: Boolean(item.is_now_playing || item.now_playing),
  };
  if (imageKey && imageBaseUrl) {
    const base = imageBaseUrl.replace(/\/$/, "");
    result.image_url = base.includes("{{key}}")
      ? base.replace("{{key}}", imageCacheName(imageKey))
      : `${base}/image/${encodeURIComponent(imageKey)}`;
    result.background_url = base.includes("{{key}}")
      ? base.replace("{{key}}", `${imageCacheName(imageKey)}.blur`)
      : `${base}/background/${encodeURIComponent(imageKey)}`;
  }
  return result;
};

const normalizeNowPlaying = (zone, imageBaseUrl = "") => {
  const nowPlaying = zone?.now_playing;
  if (!nowPlaying || typeof nowPlaying !== "object") return null;
  const item = normalizeItem({
    queue_item_id: nowPlaying.queue_item_id || nowPlaying.item_id,
    three_line: nowPlaying.three_line,
    title: nowPlaying.title,
    artist: nowPlaying.artist,
    album: nowPlaying.album,
    length: nowPlaying.length,
    image_key: nowPlaying.image_key,
  }, imageBaseUrl);
  if (item) item.position = asNumber(zone.seek_position ?? nowPlaying.seek_position);
  return item;
};

const findCurrentIndex = (items, zone, current) => {
  const candidates = [
    zone?.now_playing?.queue_item_id,
    zone?.now_playing?.item_id,
    zone?.now_playing?.queue_item,
    current?.id,
  ].filter(Boolean).map(String);

  const byId = items.findIndex((item) => candidates.includes(String(item.id)));
  if (byId >= 0) return byId;

  const flagged = items.findIndex((item) => item.is_now_playing);
  if (flagged >= 0) return flagged;

  const imageKey = zone?.now_playing?.image_key;
  const title = current?.title;
  const byMetadata = items.findIndex((item) => (
    title
      ? item.title === title && (!imageKey || item.image_key === imageKey)
      : imageKey && item.image_key === imageKey
  ));
  if (byMetadata >= 0) return byMetadata;
  return items.length === 1 ? 0 : -1;
};

const sameItem = (left, right) => Boolean(left && right && (
  (left.id && right.id && left.id === right.id) ||
  (left.title && right.title && left.title === right.title && left.image_key === right.image_key)
));

const buildSnapshot = ({ zone, queueItems = [], previousCurrent = null, imageBaseUrl = "", artworkColors = new Map() }) => {
  const normalizedItems = queueItems.map((item) => normalizeItem(item, imageBaseUrl)).filter(Boolean);
  const currentFromZone = normalizeNowPlaying(zone, imageBaseUrl);
  const currentIndex = findCurrentIndex(normalizedItems, zone, currentFromZone);
  const current = currentFromZone || (currentIndex >= 0 ? normalizedItems[currentIndex] : null);

  let previous = currentIndex > 0 ? normalizedItems[currentIndex - 1] : null;
  let next = currentIndex >= 0 ? normalizedItems[currentIndex + 1] || null : null;

  // Roon can supply current + upcoming tracks without any played history.
  const queueLacksHistory = currentIndex <= 0;
  if (!previous && queueLacksHistory && previousCurrent && !sameItem(previousCurrent, current)) previous = previousCurrent;
  if (current && previous && sameItem(previous, current)) previous = null;

  return {
    state: zone?.state || "stopped",
    zone_id: zone?.zone_id || "",
    zone_name: zone?.display_name || "",
    position: asNumber(zone?.seek_position ?? current?.position),
    duration: asNumber(current?.duration),
    current,
    previous,
    next,
    dominant_color: current?.image_key ? artworkColors.get(current.image_key) || null : null,
    updated_at: new Date().toISOString(),
  };
};

module.exports = {
  asNumber,
  buildSnapshot,
  currentTrackKey,
  imageCacheName,
  itemIdentity,
  normalizeItem,
  queueContainsCurrent,
  queueItemsFromMessage,
};
