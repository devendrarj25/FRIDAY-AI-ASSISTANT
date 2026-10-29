// Cross-platform dev launcher: `npm run desktop:dev` must work in cmd.exe and
// PowerShell too, where `VAR=value cmd` is not valid syntax.
process.env.FRIDAY_DEV_URL = process.env.FRIDAY_DEV_URL || "http://localhost:8080";
require("./main.cjs");
