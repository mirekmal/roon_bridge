const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRoonPersistence } = require("../src/roon-persistence");

test("persists Roon pairing state in the configured durable file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rdashboard-roon-state-"));
  const stateFile = path.join(directory, "data", "roonstate.json");
  const persistence = createRoonPersistence(stateFile);
  const state = { paired_core_id: "core-1", tokens: { "core-1": "secret-token" } };

  persistence.setPersistedState(state);

  assert.deepEqual(persistence.getPersistedState(), state);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), state);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
});

test("migrates the Roon state from the legacy config file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rdashboard-roon-legacy-"));
  const stateFile = path.join(directory, "roonstate.json");
  const state = { paired_core_id: "core-2", tokens: { "core-2": "legacy-token" } };
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ roonstate: state }));

  assert.deepEqual(createRoonPersistence(stateFile).getPersistedState(), state);
});
