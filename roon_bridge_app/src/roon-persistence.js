const fs = require("node:fs");
const path = require("node:path");

const createRoonPersistence = (stateFile = process.env.ROON_STATE_FILE || path.join(process.cwd(), "roonstate.json")) => {
  const legacyFile = path.join(path.dirname(stateFile), "config.json");

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };

  const getPersistedState = () => {
    const current = readJson(stateFile);
    if (current) return current.roonstate || current;

    const legacy = readJson(legacyFile);
    return legacy?.roonstate || legacy || {};
  };

  const setPersistedState = (state) => {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const temporaryFile = `${stateFile}.tmp-${process.pid}`;
      fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.chmodSync(temporaryFile, 0o600);
      fs.renameSync(temporaryFile, stateFile);
    } catch (error) {
      console.error(new Date().toISOString(), "Roon pairing state persistence failed", error.message);
    }
  };

  return { getPersistedState, setPersistedState, stateFile };
};

module.exports = { createRoonPersistence };
