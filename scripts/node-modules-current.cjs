#!/usr/bin/env node
/**
 * Exit 0 when node_modules already matches package-lock.json (the pipeline's own check), 1 when `npm ci` has to run.
 * `npm run setup` asks this before installing, so a second run on a folder that is up to date does not wipe and
 * reinstall 700 packages (twenty seconds, and a lot of files for a virus scanner to read) for nothing.
 * FRIDAY_FORCE_NPM_CI=1 always answers 1.
 */
"use strict";

const path = require("node:path");

const { nodeModulesCurrent } = require("./build-pipeline.cjs");

if (require.main === module) {
  process.exit(nodeModulesCurrent(path.resolve(__dirname, "..")) ? 0 : 1);
}

module.exports = { nodeModulesCurrent };
