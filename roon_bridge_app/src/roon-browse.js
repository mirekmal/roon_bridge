const { catalogEntryFromItem, normalizeText, scoreEntry } = require("./roon-catalog");

const callService = (service, method, options) => new Promise((resolve, reject) => {
  if (!service || typeof service[method] !== "function") return reject(new Error(`Roon Browse service does not implement ${method}`));
  service[method](options, (error, body) => {
    if (error) return reject(new Error(String(error)));
    resolve(body || {});
  });
});

const normalizedTitle = normalizeText;

const findByTitle = (items, titles) => {
  const expected = new Set(titles.map(normalizedTitle));
  return (items || []).find((item) => expected.has(normalizedTitle(item.title)));
};

const createRoonBrowse = (service, options = {}) => {
  const pageSize = Number(options.pageSize || 100);
  const sessionPrefix = options.sessionPrefix || "rdashboard";
  let sequence = 0;
  const nextSession = () => `${sessionPrefix}-${Date.now()}-${sequence++}`;

  const loadAll = async ({ hierarchy, input, zoneId, sessionKey = nextSession(), refresh = false }) => {
    const browseOptions = {
      hierarchy,
      multi_session_key: sessionKey,
      pop_all: true,
      refresh_list: refresh,
    };
    if (input) browseOptions.input = input;
    if (zoneId) browseOptions.zone_or_output_id = zoneId;
    const first = await callService(service, "browse", browseOptions);
    const items = [];
    const count = Number(first.list?.count || 0);
    for (let offset = 0; offset < count || (offset === 0 && !count); offset += pageSize) {
      const page = await callService(service, "load", {
        hierarchy,
        multi_session_key: sessionKey,
        offset,
        count: pageSize,
      });
      items.push(...(Array.isArray(page.items) ? page.items : []));
      if (!page.items?.length || items.length >= count) break;
    }
    return { items, list: first.list || null, sessionKey };
  };

  const search = async (query, zoneId) => loadAll({ hierarchy: "search", input: query, zoneId });

  const refreshAlbums = async () => {
    // Roon's album library is exposed below the general browse root. A direct
    // hierarchy:"albums" request is rejected by some Core versions with
    // InvalidRequest even though "albums" is documented as a browse hierarchy.
    await callService(service, "browse", { hierarchy: "browse", pop_all: true });
    const root = await callService(service, "load", { hierarchy: "browse", offset: 0, count: pageSize });
    const library = findByTitle(root.items, ["Library", "Biblioteka"]);
    if (!library?.item_key) throw new Error("Roon Browse root has no Library entry");

    const libraryLevel = await callService(service, "browse", {
      hierarchy: "browse",
      item_key: library.item_key,
    });
    if (libraryLevel.action !== "list") throw new Error("Roon Browse could not open Library");
    const libraryItems = await callService(service, "load", {
      hierarchy: "browse",
      level: libraryLevel.list?.level,
      offset: 0,
      count: pageSize,
    });
    const albums = findByTitle(libraryItems.items, ["Albums", "Albumy"]);
    if (!albums?.item_key) throw new Error("Roon Library has no Albums entry");

    const albumLevel = await callService(service, "browse", {
      hierarchy: "browse",
      item_key: albums.item_key,
    });
    if (albumLevel.action !== "list") throw new Error("Roon Browse could not open Albums");

    const entries = [];
    const total = Number(albumLevel.list?.count || 0);
    for (let offset = 0; offset < total || (offset === 0 && !total); offset += pageSize) {
      const page = await callService(service, "load", {
        hierarchy: "browse",
        level: albumLevel.list?.level,
        offset,
        count: pageSize,
      });
      entries.push(...(page.items || []).map((item) => catalogEntryFromItem({
        ...item,
        kind: "album",
        album: item.title,
        artist: item.subtitle,
      })).filter(Boolean));
      if (!page.items?.length || entries.length >= total) break;
    }
    return entries;
  };

  const browseLibraryCategory = async (titles, sessionKey = nextSession()) => {
    await callService(service, "browse", { hierarchy: "browse", multi_session_key: sessionKey, pop_all: true });
    const root = await callService(service, "load", { hierarchy: "browse", multi_session_key: sessionKey, offset: 0, count: pageSize });
    const library = findByTitle(root.items, ["Library", "Biblioteka"]);
    if (!library?.item_key) throw new Error("Roon Browse root has no Library entry");
    const libraryLevel = await callService(service, "browse", { hierarchy: "browse", item_key: library.item_key, multi_session_key: sessionKey });
    if (libraryLevel.action !== "list") throw new Error("Roon Browse could not open Library");
    const libraryItems = await callService(service, "load", {
      hierarchy: "browse", multi_session_key: sessionKey, level: libraryLevel.list?.level, offset: 0, count: pageSize,
    });
    const category = findByTitle(libraryItems.items, titles);
    if (!category?.item_key) throw new Error(`Roon Library has no ${titles[0]} entry`);
    const categoryLevel = await callService(service, "browse", { hierarchy: "browse", item_key: category.item_key, multi_session_key: sessionKey });
    if (categoryLevel.action !== "list") throw new Error(`Roon Browse could not open ${titles[0]}`);
    return { level: categoryLevel.list?.level, count: Number(categoryLevel.list?.count || 0), sessionKey };
  };

  const loadArtistItems = async () => {
    const category = await browseLibraryCategory(["Artists", "Wykonawcy"]);
    const items = [];
    for (let offset = 0; offset < category.count || (offset === 0 && !category.count); offset += pageSize) {
      const page = await callService(service, "load", {
        hierarchy: "browse", multi_session_key: category.sessionKey, level: category.level, offset, count: pageSize,
      });
      items.push(...(page.items || []));
      if (!page.items?.length || items.length >= category.count) break;
    }
    return { items, sessionKey: category.sessionKey };
  };

  const play = async ({ itemKey, hierarchy = "search", zoneId, sessionKey, actionPattern = /play|odtwórz/i }) => {
    if (!zoneId) throw new Error("A Roon zone or output is required for playback");
    let selected = await callService(service, "browse", {
      hierarchy,
      item_key: itemKey,
      zone_or_output_id: zoneId,
      multi_session_key: sessionKey,
    });
    for (let depth = 0; depth <= 3; depth += 1) {
      const actions = await callService(service, "load", {
        hierarchy,
        multi_session_key: sessionKey,
        offset: 0,
        count: pageSize,
      });
      const action = (actions.items || []).find((item) => item.item_key
        && (item.hint === "action" || item.hint == null)
        && actionPattern.test(item.title || ""));
      if (action?.item_key) {
        const result = await callService(service, "browse", {
          hierarchy,
          item_key: action.item_key,
          zone_or_output_id: zoneId,
          multi_session_key: sessionKey,
        });
        return { action: action.title, result };
      }
      if (depth === 3) break;
      const selectable = (actions.items || []).filter((item) => item.item_key && item.hint !== "header");
      const container = selectable.find((item) => item.hint === "action_list")
        || (selectable.length > 0 && selectable.every((item) => item.hint === "list") ? selectable[0] : null);
      if (!container?.item_key) break;
      selected = await callService(service, "browse", {
        hierarchy,
        item_key: container.item_key,
        multi_session_key: sessionKey,
      });
      if (selected.action !== "list") break;
    }
    throw new Error(`Roon did not offer a playback action for ${itemKey}`);
  };

  const findArtist = (name, artistItems) => {
    const expected = normalizedTitle(name);
    return artistItems.find((item) => normalizedTitle(item.title) === expected && item.item_key) || null;
  };

  const playArtistFromCatalog = async ({ artist, zoneId, catalog, queue = false }) => {
    if (!catalog) return { status: "not_found", artist };
    const expectedArtist = normalizedTitle(artist);
    const albums = catalog.entries()
      .filter((entry) => entry.kind === "album" && normalizedTitle(entry.artist) === expectedArtist)
      .filter((entry, index, entries) => entries.findIndex((candidate) => normalizedTitle(candidate.album || candidate.title) === normalizedTitle(entry.album || entry.title)) === index);
    if (!albums.length) return { status: "not_found", artist };

    const queued = [];
    const unavailable = [];
    for (const album of albums) {
      const result = await search(`${artist} ${album.album || album.title}`, zoneId);
      const candidate = result.items.find((item) => item.item_key
        && normalizedTitle(item.title) === normalizedTitle(album.album || album.title)
        && normalizedTitle(item.subtitle).includes(expectedArtist));
      if (!candidate) {
        unavailable.push(album.album || album.title);
        continue;
      }
      try {
        const played = await play({
          itemKey: candidate.item_key,
          hierarchy: "search",
          zoneId,
          sessionKey: result.sessionKey,
          queue: queue || queued.length > 0,
          actionPattern: queue || queued.length > 0
            ? /add to queue|queue|dodaj.*kolejki/i
            : /play|odtwórz/i,
        });
        queued.push({ album: album.album || album.title, action: played.action });
      } catch (error) {
        unavailable.push(album.album || album.title);
      }
    }
    if (!queued.length) return { status: "not_found", artist, matches: albums.map((entry) => entry.album || entry.title) };
    return { status: "queued", artist, albums: queued, unavailable_albums: unavailable };
  };

  const playArtist = async ({ artist, zoneId, artistItems, sessionKey, queue = false, catalog }) => {
    const selected = await findArtist(artist, artistItems);
    if (!selected) return playArtistFromCatalog({ artist, zoneId, catalog, queue });
    try {
      const result = await play({
        itemKey: selected.item_key,
        hierarchy: "browse",
        zoneId,
        sessionKey,
        actionPattern: queue ? /add to queue|queue|dodaj.*kolejki/i : /play|odtwórz/i,
      });
      return { status: "queued", artist: selected.title, action: result.action };
    } catch (error) {
      if (!String(error?.message || error).includes("Roon did not offer a playback action")) throw error;
      return playArtistFromCatalog({ artist: selected.title, zoneId, catalog, queue });
    }
  };

  const playArtistCatalog = async ({ artist, zoneId, catalog }) => {
    const { items: artistItems, sessionKey } = await loadArtistItems();
    const result = await playArtist({ artist, zoneId, artistItems, sessionKey, catalog });
    if (result.status === "not_found") return { status: "not_found", matches: [] };
    return {
      status: "played",
      selected: { title: result.artist, subtitle: "Wszystkie utwory z biblioteki Roon", albums: result.albums?.length },
      action: result.action || result.albums?.[0]?.action || "Play now",
      queued: result.albums || [],
      unavailable_albums: result.unavailable_albums || [],
    };
  };

  const playSimilarArtists = async ({ artist, similarArtists, zoneId, catalog }) => {
    const { items: artistItems, sessionKey } = await loadArtistItems();
    const candidates = Array.isArray(similarArtists) ? similarArtists : [];
    const names = [...new Set(candidates.map((name) => String(name || "").trim()).filter(Boolean))]
      .filter((name) => normalizedTitle(name) !== normalizedTitle(artist))
      .slice(0, 8);
    const verified = names.map((name) => findArtist(name, artistItems));
    const matches = verified.filter(Boolean);
    if (!matches.length) return { status: "not_found", matches: [] };

    const queued = [];
    for (let index = 0; index < matches.length; index += 1) {
      const result = await playArtist({
        artist: matches[index].title,
        zoneId,
        artistItems,
        sessionKey,
        queue: index > 0,
        catalog,
      });
      if (result.status === "queued") queued.push({ artist: result.artist, action: result.action });
    }
    return {
      status: queued.length ? "played" : "not_found",
      selected: { title: artist, similar_artists: queued.map(({ artist: name }) => name) },
      matches: names.filter((name, index) => !verified[index]),
      queued,
    };
  };

  const searchAndPlay = async ({ query, request, zoneId, catalog, limit = 10 }) => {
    const localMatches = catalog.search(request || { q: query }, limit);
    if (!localMatches.length) return { status: "not_found", matches: [] };
    const live = await search(query, zoneId);
    const candidates = live.items
      .map((item) => ({ ...item, catalog: localMatches.map((entry) => ({ entry, score: scoreEntry(entry, { q: `${item.title} ${item.subtitle || ""}` }) })).sort((a, b) => b.score - a.score)[0] }))
      .filter((item) => item.catalog && item.catalog.score > 0 && item.item_key)
      .sort((left, right) => (right.catalog?.score || 0) - (left.catalog?.score || 0));
    if (!candidates.length) return { status: "not_found", matches: localMatches };
    if (candidates.length > 1 && candidates[0].catalog && candidates[1].catalog && candidates[0].catalog.score === candidates[1].catalog.score) {
      return { status: "ambiguous", matches: candidates.slice(0, limit).map((item) => ({ title: item.title, subtitle: item.subtitle })) };
    }
    const selected = candidates[0];
    const played = await play({ itemKey: selected.item_key, zoneId, sessionKey: live.sessionKey });
    return { status: "played", selected: { title: selected.title, subtitle: selected.subtitle }, action: played.action };
  };

  return { loadAll, refreshAlbums, search, play, searchAndPlay, playArtistCatalog, playSimilarArtists };
};

module.exports = { createRoonBrowse };
