const jpeg = require("jpeg-js");

const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));

const dominantColor = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  let decoded;
  try {
    decoded = jpeg.decode(buffer, { useTArray: true });
  } catch (_error) {
    return null;
  }
  const buckets = new Map();

  for (let index = 0; index < decoded.data.length; index += 16) {
    const r = decoded.data[index];
    const g = decoded.data[index + 1];
    const b = decoded.data[index + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 48 || max - min < 22) continue;

    const saturation = (max - min) / 255;
    const brightness = max / 255;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const bucket = buckets.get(key) || { score: 0 };
    bucket.score += 0.35 + saturation * 1.6 + brightness * 0.9;
    buckets.set(key, bucket);
  }

  const best = [...buckets.entries()].sort((left, right) => right[1].score - left[1].score)[0];
  if (!best) return null;
  const [r, g, b] = best[0].split(",").map((value) => (Number(value) << 4) + 8);
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};

const resizedArtwork = (decoded, maxDimension = 160) => {
  const scale = Math.min(1, maxDimension / Math.max(decoded.width, decoded.height));
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const data = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(decoded.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(decoded.width - 1, Math.floor(x / scale));
      const sourceIndex = (sourceY * decoded.width + sourceX) * 4;
      const targetIndex = (y * width + x) * 4;
      data[targetIndex] = decoded.data[sourceIndex];
      data[targetIndex + 1] = decoded.data[sourceIndex + 1];
      data[targetIndex + 2] = decoded.data[sourceIndex + 2];
      data[targetIndex + 3] = 255;
    }
  }

  return { data, width, height };
};

const boxBlur = ({ data, width, height }, radius) => {
  const horizontal = Buffer.alloc(data.length);
  const blurred = Buffer.alloc(data.length);
  const diameter = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sampleX = Math.max(0, Math.min(width - 1, x + offset));
        const index = (y * width + sampleX) * 4;
        red += data[index];
        green += data[index + 1];
        blue += data[index + 2];
      }
      const index = (y * width + x) * 4;
      horizontal[index] = red / diameter;
      horizontal[index + 1] = green / diameter;
      horizontal[index + 2] = blue / diameter;
      horizontal[index + 3] = 255;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sampleY = Math.max(0, Math.min(height - 1, y + offset));
        const index = (sampleY * width + x) * 4;
        red += horizontal[index];
        green += horizontal[index + 1];
        blue += horizontal[index + 2];
      }
      const index = (y * width + x) * 4;
      // Darken the pre-rendered layer so it remains a subdued background even
      // when Chromium cannot apply the card's GPU CSS filter.
      blurred[index] = clampByte((red / diameter) * 0.42);
      blurred[index + 1] = clampByte((green / diameter) * 0.42);
      blurred[index + 2] = clampByte((blue / diameter) * 0.42);
      blurred[index + 3] = 255;
    }
  }

  return { data: blurred, width, height };
};

const blurredArtwork = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  try {
    const decoded = jpeg.decode(buffer, { useTArray: true });
    const resized = resizedArtwork(decoded);
    const radius = Math.max(5, Math.round(Math.min(resized.width, resized.height) * 0.07));
    const blurred = boxBlur(resized, radius);
    return jpeg.encode(blurred, 76).data;
  } catch (_error) {
    return null;
  }
};

module.exports = { blurredArtwork, dominantColor };
