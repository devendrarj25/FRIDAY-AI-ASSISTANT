async function run({ ms } = {}) {
  const total = Number(ms);
  if (!Number.isFinite(total)) return { ok: false, error: "Milliseconds are required." };
  const abs = Math.abs(Math.floor(total));
  const hours = Math.floor(abs / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  const seconds = Math.floor((abs % 60000) / 1000);
  return {
    ok: true,
    ms: total,
    hours,
    minutes,
    seconds,
    label: hours + "h " + minutes + "m " + seconds + "s",
  };
}
module.exports = { run };
