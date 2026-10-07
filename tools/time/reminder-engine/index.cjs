// FRIDAY · tools/time/reminder-engine
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");
const reminders = require(path.join(ELECTRON, "reminder-engine.cjs"));
const contract = require(path.join(ELECTRON, "friday-contract.cjs"));

async function run(input = {}) {
  const root = input.root || contract.rootFromEnv();
  return reminders.run({ ...input, root });
}

module.exports = { run };
