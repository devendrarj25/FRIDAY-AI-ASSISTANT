#!/usr/bin/env node
/**
 * Thin alias of scripts/preflight.cjs. One implementation.
 */
"use strict";

const preflight = require("./preflight.cjs");

module.exports = preflight;

if (require.main === module) preflight.main();
