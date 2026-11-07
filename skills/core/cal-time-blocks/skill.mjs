// FRIDAY · skill: cal-time-blocks
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Lay a list of tasks with durations out as a timed schedule from a start time, with a short break between them.

const hhmm = (mins) => {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const DUR = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i;

export async function run(input = {}) {
  let text = String(input?.prompt ?? input?.text ?? "");
  let buffer = input.buffer != null ? Number(input.buffer) : 5;
  const bm = /(\d+)\s*(?:min(?:ute)?s?|m)\s*(?:break|buffer|gap)s?/i.exec(text);
  if (bm) {
    if (input.buffer == null) buffer = Number(bm[1]);
    text = text.replace(bm[0], " ");
  }
  let start = 9 * 60;
  const tm =
    /\b(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text) || /\b(\d{1,2})()\s*(am|pm)\b/i.exec(text);
  if (tm) {
    let h = Number(tm[1]);
    const mm = Number(tm[2] || 0);
    const ap = (tm[3] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h < 24 && mm < 60) start = h * 60 + mm;
    text = text.replace(tm[0], " ");
  }
  if (input.start != null) {
    const sm = /^(\d{1,2}):(\d{2})$/.exec(String(input.start));
    if (sm) start = Number(sm[1]) * 60 + Number(sm[2]);
  }
  const pieces = text.split(/[,;\n]|\band\b|\bthen\b|->/i);
  const tasks = [];
  for (const piece of pieces) {
    const d = DUR.exec(piece);
    if (!d) continue;
    const minutes = Math.round(Number(d[1]) * (/^h/i.test(d[2]) ? 60 : 1));
    if (minutes < 1 || minutes > 1440) continue;
    let name = piece.replace(d[0], " ").replace(/\bfor\b/gi, " ");
    for (let i = 0; i < 3; i++) {
      name = name.replace(
        /^[\s:,.-]*(?:plan|schedule|my day|day plan|timetable|starting|start|begin|at|from)\b[\s:,.-]*/i,
        "",
      );
    }
    name = name.replace(/^[\s:,.()-]+|[\s:,.()-]+$/g, "").replace(/\s+/g, " ");
    tasks.push({ task: name || `Task ${tasks.length + 1}`, minutes });
  }
  if (!tasks.length) {
    return {
      ok: false,
      error: "Give tasks with durations, e.g. plan 9:00: report 45m, email 20m, gym 30m.",
    };
  }
  let t = start;
  const schedule = tasks.map((x, i) => {
    const row = { task: x.task, start: hhmm(t), end: hhmm(t + x.minutes), minutes: x.minutes };
    t += x.minutes + (i < tasks.length - 1 ? buffer : 0);
    return row;
  });
  const total = tasks.reduce((a, x) => a + x.minutes, 0);
  return {
    ok: true,
    schedule,
    bufferMinutes: buffer,
    totalMinutes: total,
    finish: hhmm(t),
    answer:
      schedule.map((r) => `${r.start}-${r.end}  ${r.task} (${r.minutes} min)`).join("\n") +
      `\nDone by ${hhmm(t)}.`,
  };
}

export default run;
