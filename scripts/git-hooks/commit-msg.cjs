/**
 * Owner opt-in. Registered by `npm run setup:hooks`.
 * Refuses a commit message that carries an assistant credit, a session link or a tool trailer,
 * the same rule PR Validation applies, so the mistake never leaves this clone.
 */
const fs = require("node:fs");
const path = require("node:path");
const { messageProblems } = require(path.join(__dirname, "..", "check-provenance.cjs"));

const file = process.argv[2];
if (!file) process.exit(0);
const problems = messageProblems("commit", fs.readFileSync(file, "utf8"));
if (problems.length) {
  console.error(problems.join("\n"));
  console.error(
    "Remove the credit or trailer. Only devendrarj25 is recorded (see AGENTS.md, Identity).",
  );
  process.exit(1);
}
