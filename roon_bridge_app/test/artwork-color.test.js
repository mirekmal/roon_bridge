const test = require("node:test");
const assert = require("node:assert/strict");
const jpeg = require("jpeg-js");
const { blurredArtwork, dominantColor } = require("../src/artwork-color");

test("extracts a stable artwork color from JPEG bytes", () => {
  const image = jpeg.encode({
    data: Buffer.from([240, 96, 32, 255, 240, 96, 32, 255, 240, 96, 32, 255, 240, 96, 32, 255]),
    width: 2,
    height: 2,
  }, 90).data;
  assert.match(dominantColor(image), /^#[0-9a-f]{6}$/i);
  assert.notEqual(dominantColor(image), "#ffab26");
});

test("creates a compact darkened blurred JPEG fallback", () => {
  const image = jpeg.encode({
    data: Buffer.from([
      240, 32, 32, 255, 240, 32, 32, 255,
      32, 32, 240, 255, 32, 32, 240, 255,
    ]),
    width: 2,
    height: 2,
  }, 90).data;
  const blurred = blurredArtwork(image);
  assert.ok(Buffer.isBuffer(blurred));
  const decoded = jpeg.decode(blurred, { useTArray: true });
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.ok(decoded.data[0] < 240);
});
