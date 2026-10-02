const fs = require("node:fs");
const path = require("node:path");

const TRANSLITERATION = {
  ł: "l", Ł: "L", đ: "d", Đ: "D", ð: "d", Ð: "D", þ: "th", Þ: "Th",
  ß: "ss", æ: "ae", Æ: "Ae", œ: "oe", Œ: "Oe",
};

const normalizeText = (value) => String(value || "")
  .replace(/[łŁđĐðÐþÞßæÆœŒ]/g, (character) => TRANSLITERATION[character] || character)
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase("pl-PL")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim()
  .replace(/\s+/g, " ");

const tokenize = (value) => normalizeText(value).split(" ").filter(Boolean);

const stableKey = (entry) => [entry.kind, entry.artist, entry.album, entry.title]
  .map(normalizeText)
  .join("|");

const catalogEntryFromItem = (item) => {
  const title = String(item?.title || "").trim();
  const subtitle = String(item?.subtitle || "").trim();
  if (!title || item?.hint === "header") return null;
  return {
    kind: item?.kind || "album",
    title,
    artist: String(item?.artist || subtitle || "").trim(),
    album: String(item?.album || (item?.kind === "track" ? subtitle : title)).trim(),
    subtitle,
  };
};

const scoreEntry = (entry, request) => {
  const fields = {
    title: normalizeText(entry.title),
    artist: normalizeText(entry.artist),
    album: normalizeText(entry.album),
    subtitle: normalizeText(entry.subtitle),
  };
  const requested = {
    title: normalizeText(request.track || request.title),
    artist: normalizeText(request.artist),
    album: normalizeText(request.album),
  };
  let score = 0;
  for (const [field, value] of Object.entries(requested)) {
    if (!value) continue;
    const alternatives = field === "artist" ? [fields.artist, fields.subtitle] : [fields[field]];
    if (alternatives.some((candidate) => candidate === value)) score += 100;
    else if (alternatives.some((candidate) => candidate.includes(value))) score += 45;
    else if (tokenize(value).every((token) => alternatives.some((candidate) => candidate.includes(token)))) score += 15;
  }
  const query = normalizeText(request.q || request.query);
  if (query) {
    const haystack = Object.values(fields).join(" ");
    if (haystack === query) score += 100;
    else if (haystack.includes(query)) score += 35;
    else score += tokenize(query).filter((token) => haystack.includes(token)).length * 5;
  }
  return score;
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
};

const createRoonCatalog = (file, clock = () => new Date()) => {
  let state = readJson(file) || { version: 1, refreshed_at: null, entries: [] };
  if (!Array.isArray(state.entries)) state.entries = [];

  const replace = (items) => {
    const entries = new Map();
    for (const item of items) {
      const entry = item?.kind ? item : catalogEntryFromItem(item);
      if (!entry) continue;
      entries.set(stableKey(entry), {
        kind: entry.kind,
        title: entry.title,
        artist: entry.artist || "",
        album: entry.album || "",
        subtitle: entry.subtitle || "",
      });
    }
    state = { version: 1, refreshed_at: clock().toISOString(), entries: [...entries.values()] };
    writeJson(file, state);
    return state;
  };

  return {
    file,
    get refreshedAt() { return state.refreshed_at; },
    get size() { return state.entries.length; },
    entries: () => state.entries.map((entry) => ({ ...entry })),
    replace,
    search(request = {}, limit = 10) {
      return state.entries
        .map((entry) => ({ ...entry, score: scoreEntry(entry, request) }))
        .filter((entry) => entry.score > 0 || (!request.q && !request.query && !request.artist && !request.album && !request.track && !request.title))
        .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title, "pl"))
        .slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)));
    },
    summary() {
      return { version: state.version, refreshed_at: state.refreshed_at, count: state.entries.length };
    },
  };
};

module.exports = { catalogEntryFromItem, createRoonCatalog, normalizeText, scoreEntry };
