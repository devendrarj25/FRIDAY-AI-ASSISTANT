async function run({ name } = {}) {
  if (!name) return { ok: false, error: "A variable name is required." };
  const key = String(name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    return { ok: false, error: "That is not a valid env name." };
  const present = Object.prototype.hasOwnProperty.call(process.env, key);
  return { ok: true, name: key, present, value: present ? String(process.env[key]) : null };
}
module.exports = { run };
