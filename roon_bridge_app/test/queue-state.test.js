const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSnapshot,
  currentTrackKey,
  imageCacheName,
  normalizeItem,
  queueContainsCurrent,
  queueItemsFromMessage,
} = require("../src/queue-state");

const imageBaseUrl = "http://bridge.local:8090";

const queue = [
  {
    queue_item_id: "one",
    three_line: { line1: "One", line2: "Artist One", line3: "Album One" },
    length: 201,
    image_key: "image-one",
  },
  {
    queue_item_id: "two",
    three_line: { line1: "Two", line2: "Artist Two", line3: "Album Two" },
    length: 244,
    image_key: "image-two",
  },
  {
    queue_item_id: "three",
    three_line: { line1: "Three", line2: "Artist Three", line3: "Album Three" },
    length: 185,
    image_key: "image-three",
  },
];

test("normalizes queue artwork into a browser URL", () => {
  const item = normalizeItem(queue[0], imageBaseUrl);
  assert.equal(item.title, "One");
  assert.equal(item.artist, "Artist One");
  assert.equal(item.album, "Album One");
  assert.equal(item.image_url, "http://bridge.local:8090/image/image-one");
  const cached = normalizeItem(queue[0], "https://hassio.mirekmal.com/local/rdashboard-art/{{key}}.jpg");
  assert.equal(cached.image_url, `https://hassio.mirekmal.com/local/rdashboard-art/${imageCacheName("image-one")}.jpg`);
  assert.equal(cached.background_url, `https://hassio.mirekmal.com/local/rdashboard-art/${imageCacheName("image-one")}.blur.jpg`);
});

test("accepts the queue message shape and selects neighboring tracks", () => {
  assert.deepEqual(queueItemsFromMessage({ items: queue }), queue);
  assert.deepEqual(queueItemsFromMessage({ data: { items: queue } }), queue);
  const snapshot = buildSnapshot({
    zone: {
      zone_id: "zone-1",
      display_name: "Living Room",
      state: "playing",
      seek_position: 31,
      now_playing: {
        queue_item_id: "two",
        length: 244,
        image_key: "image-two",
        three_line: { line1: "Two", line2: "Artist Two", line3: "Album Two" },
      },
    },
    queueItems: queue,
    imageBaseUrl,
  });
  assert.equal(snapshot.current.id, "two");
  assert.equal(snapshot.previous.id, "one");
  assert.equal(snapshot.next.id, "three");
  assert.equal(snapshot.position, 31);
});

test("treats an empty active queue as stale and identifies track changes", () => {
  const zone = {
    state: "playing",
    now_playing: {
      queue_item_id: "two",
      image_key: "image-two",
      three_line: { line1: "Two" },
    },
  };
  assert.equal(queueContainsCurrent([], zone), false);
  assert.equal(queueContainsCurrent([{ queue_item_id: "two" }], zone), true);
  assert.equal(currentTrackKey(zone), "two");
  assert.equal(currentTrackKey({ now_playing: { queue_item_id: "three" } }), "three");
  assert.equal(currentTrackKey({ state: "stopped" }), "");
});

test("uses the previously observed current item when Roon omits queue history", () => {
  const previousCurrent = normalizeItem(queue[0], imageBaseUrl);
  const snapshot = buildSnapshot({
    zone: {
      zone_id: "zone-1",
      display_name: "Living Room",
      state: "playing",
      now_playing: {
        queue_item_id: "two",
        length: 244,
        image_key: "image-two",
        three_line: { line1: "Two", line2: "Artist Two", line3: "Album Two" },
      },
    },
    queueItems: [queue[1]],
    previousCurrent,
    imageBaseUrl,
  });
  assert.equal(snapshot.previous.id, "one");
  assert.equal(snapshot.next, null);
});

test("retains previous artwork on repeated snapshots with upcoming queue entries", () => {
  const previousCurrent = normalizeItem(queue[0], imageBaseUrl);
  const zone = { state: "playing", now_playing: queue[1] };
  for (const state of ["playing", "playing", "paused"]) {
    const snapshot = buildSnapshot({
      zone: { ...zone, state }, queueItems: queue.slice(1), previousCurrent, imageBaseUrl,
    });
    assert.equal(snapshot.previous.title, "One");
    assert.equal(snapshot.next.title, "Three");
  }
  const same = buildSnapshot({ zone, queueItems: queue.slice(1), previousCurrent: normalizeItem(queue[1]) });
  assert.equal(same.previous, null);
});

test("distinguishes successive tracks sharing album artwork without zone queue IDs", () => {
  const albumQueue = queue.map(item => ({ ...item, image_key: "same-album" }));
  const { queue_item_id, ...nowPlaying } = albumQueue[1];
  const zone = { state: "playing", now_playing: nowPlaying };
  const snapshot = buildSnapshot({ zone, queueItems: albumQueue });
  assert.equal(snapshot.previous.title, "One");
  assert.equal(snapshot.current.title, "Two");
  assert.equal(snapshot.next.title, "Three");
  assert.equal(queueContainsCurrent([albumQueue[0]], zone), false);
  assert.equal(queueContainsCurrent(albumQueue, zone), true);
  const { queue_item_id: otherId, ...otherTrack } = albumQueue[2];
  assert.notEqual(currentTrackKey(zone), currentTrackKey({ now_playing: otherTrack }));
});
