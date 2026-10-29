/**
 * FRIDAY · call and meeting pause.
 *
 * A known meeting process means FRIDAY stays quiet. Off Windows this returns
 * unsupported and does not spawn anything. The Windows process list is
 * unverified until the owner's PC runs it.
 */
const { execFile } = require("child_process");

const MEETING = [/teams/i, /zoom/i, /cpthost/i, /webex/i, /skype/i];

function meetingDetected(names) {
  return (names || []).some((name) => MEETING.some((pattern) => pattern.test(String(name))));
}

function status() {
  if (process.platform !== "win32") {
    return Promise.resolve({ ok: true, meeting: false, names: [], reason: "unsupported" });
  }
  return new Promise((resolve) => {
    execFile(
      "tasklist",
      ["/FO", "CSV", "/NH"],
      { timeout: 4000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, meeting: false, names: [], reason: "unsupported" });
          return;
        }
        const names = String(stdout || "")
          .split(/\r?\n/)
          .map((line) => line.split(",")[0]?.replace(/"/g, "") || "")
          .filter(Boolean);
        resolve({ ok: true, meeting: meetingDetected(names), names, reason: "" });
      },
    );
  });
}

module.exports = { meetingDetected, status };
