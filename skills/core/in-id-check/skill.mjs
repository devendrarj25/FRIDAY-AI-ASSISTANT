// FRIDAY · skill: in-id-check
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Checks the FORMAT and check digit of Indian identifiers: PAN, GSTIN, IFSC, PIN code, UPI id, mobile, Aadhaar.
// A passing check means the number is well formed. It does not mean the person or firm exists or is active.

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const STATES = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  10: "Bihar",
  11: "Sikkim",
  12: "Arunachal Pradesh",
  13: "Nagaland",
  14: "Manipur",
  15: "Mizoram",
  16: "Tripura",
  17: "Meghalaya",
  18: "Assam",
  19: "West Bengal",
  20: "Jharkhand",
  21: "Odisha",
  22: "Chhattisgarh",
  23: "Madhya Pradesh",
  24: "Gujarat",
  26: "Dadra and Nagar Haveli and Daman and Diu",
  27: "Maharashtra",
  28: "Andhra Pradesh (old)",
  29: "Karnataka",
  30: "Goa",
  31: "Lakshadweep",
  32: "Kerala",
  33: "Tamil Nadu",
  34: "Puducherry",
  35: "Andaman and Nicobar Islands",
  36: "Telangana",
  37: "Andhra Pradesh",
  38: "Ladakh",
};
const HOLDER = {
  A: "Association of Persons",
  B: "Body of Individuals",
  C: "Company",
  F: "Firm / LLP",
  G: "Government agency",
  H: "Hindu Undivided Family",
  L: "Local authority",
  J: "Artificial juridical person",
  P: "Individual",
  T: "Trust",
  K: "Krish (trust)",
};
const PIN_REGION = {
  1: "Delhi, Haryana, Punjab, Himachal Pradesh, Jammu and Kashmir, Ladakh, Chandigarh",
  2: "Uttar Pradesh, Uttarakhand",
  3: "Rajasthan, Gujarat, Daman and Diu, Dadra and Nagar Haveli",
  4: "Maharashtra, Goa, Madhya Pradesh, Chhattisgarh",
  5: "Andhra Pradesh, Telangana, Karnataka",
  6: "Kerala, Tamil Nadu, Puducherry, Lakshadweep",
  7: "West Bengal, Odisha, Assam and the North-East, Andaman and Nicobar",
  8: "Bihar, Jharkhand",
  9: "Army Post Office / Field Post Office",
};

// Luhn mod N over ALPHABET (the GSTIN check character).
function luhnModN(text) {
  const n = ALPHABET.length;
  let factor = 1;
  let sum = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const code = ALPHABET.indexOf(text[i]);
    if (code < 0) return null;
    let add = factor * code;
    factor = factor === 2 ? 1 : 2;
    add = Math.floor(add / n) + (add % n);
    sum += add;
  }
  return sum % n;
}

const Dt = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const Pt = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const verhoeff = (digits) =>
  [...digits].reverse().reduce((c, ch, i) => Dt[c][Pt[i % 8][Number(ch)]], 0) === 0;

export function checkPan(raw) {
  const v = raw.toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v))
    return {
      type: "PAN",
      value: v,
      valid: false,
      reason: "A PAN is 5 letters, 4 digits, 1 letter (for example ABCPE1234F).",
    };
  if (!HOLDER[v[3]])
    return {
      type: "PAN",
      value: v,
      valid: false,
      reason: `The 4th letter "${v[3]}" is not a valid holder type.`,
    };
  if (v.slice(5, 9) === "0000")
    return { type: "PAN", value: v, valid: false, reason: "The serial number cannot be 0000." };
  return { type: "PAN", value: v, valid: true, holderType: HOLDER[v[3]] };
}

export function checkGstin(raw) {
  const v = raw.toUpperCase().replace(/[\s-]/g, "");
  if (v.length !== 15)
    return {
      type: "GSTIN",
      value: v,
      valid: false,
      reason: `A GSTIN has 15 characters, this has ${v.length}.`,
    };
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(v))
    return {
      type: "GSTIN",
      value: v,
      valid: false,
      reason:
        "The pattern is 2 digits (state), the 10-character PAN, 1 entity digit or letter, Z, and a check character.",
    };
  const state = v.slice(0, 2);
  const warnings = [];
  if (state === "25")
    warnings.push("State code 25 (Daman and Diu) is no longer used; it is now 26.");
  else if (state === "97" || state === "99")
    warnings.push(`State code ${state} is a special code, not a state; confirm it on gst.gov.in.`);
  else if (!STATES[state])
    return { type: "GSTIN", value: v, valid: false, reason: `"${state}" is not a GST state code.` };
  if (v[12] === "0")
    return {
      type: "GSTIN",
      value: v,
      valid: false,
      reason: "The 13th character (entity number) cannot be 0.",
    };
  if (v[13] !== "Z")
    return { type: "GSTIN", value: v, valid: false, reason: 'The 14th character must be "Z".' };
  const pan = checkPan(v.slice(2, 12));
  if (!pan.valid)
    return {
      type: "GSTIN",
      value: v,
      valid: false,
      reason: `The PAN inside is not valid: ${pan.reason}`,
    };
  if (luhnModN(v) !== 0)
    return {
      type: "GSTIN",
      value: v,
      valid: false,
      reason: "The check character does not match: a character was mistyped.",
    };
  return {
    type: "GSTIN",
    value: v,
    valid: true,
    state: STATES[state] ?? "special code",
    pan: v.slice(2, 12),
    holderType: pan.holderType,
    entityNumber: v[12],
    warnings,
  };
}

export function checkIfsc(raw) {
  const v = raw.toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v))
    return {
      type: "IFSC",
      value: v,
      valid: false,
      reason:
        "An IFSC is 4 bank letters, the digit 0, then 6 letters or digits (for example HDFC0001234).",
    };
  return {
    type: "IFSC",
    value: v,
    valid: true,
    bankCode: v.slice(0, 4),
    branchCode: v.slice(5),
    note: "Format only: it does not prove the branch exists.",
  };
}

export function checkPin(raw) {
  const v = raw.replace(/[\s-]/g, "");
  if (!/^[1-9][0-9]{5}$/.test(v))
    return {
      type: "PIN",
      value: v,
      valid: false,
      reason: "A PIN code is 6 digits and does not start with 0.",
    };
  return { type: "PIN", value: v, valid: true, region: PIN_REGION[v[0]] };
}

export function checkUpi(raw) {
  const v = raw.trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$/.test(v))
    return {
      type: "UPI",
      value: v,
      valid: false,
      reason:
        "A UPI id looks like name@bank (letters, digits, dot, dash, underscore before the @).",
    };
  return {
    type: "UPI",
    value: v,
    valid: true,
    handle: v.split("@")[1],
    note: "Format only: it does not prove the account exists.",
  };
}

export function checkMobile(raw) {
  const digits = raw
    .replace(/[\s()-]/g, "")
    .replace(/^\+?91/, "")
    .replace(/^0/, "");
  if (!/^[6-9][0-9]{9}$/.test(digits))
    return {
      type: "Mobile",
      value: raw.trim(),
      valid: false,
      reason:
        "An Indian mobile number has 10 digits and starts with 6, 7, 8 or 9 (after +91 or 0).",
    };
  return { type: "Mobile", value: digits, valid: true, international: `+91${digits}` };
}

export function checkAadhaar(raw) {
  const v = raw.replace(/[\s-]/g, "");
  if (!/^[2-9][0-9]{11}$/.test(v))
    return {
      type: "Aadhaar",
      value: "************",
      valid: false,
      reason: "An Aadhaar number has 12 digits and does not start with 0 or 1.",
    };
  if (v === [...v].reverse().join(""))
    return {
      type: "Aadhaar",
      value: `********${v.slice(-4)}`,
      valid: false,
      reason: "A palindrome cannot be an Aadhaar number.",
    };
  if (!verhoeff(v))
    return {
      type: "Aadhaar",
      value: `********${v.slice(-4)}`,
      valid: false,
      reason: "The check digit does not match: a digit was mistyped.",
    };
  return {
    type: "Aadhaar",
    value: `********${v.slice(-4)}`,
    valid: true,
    note: "Checksum only, done on this PC. The number is not stored or sent anywhere.",
  };
}

function detect(text) {
  const t = text.trim();
  const compact = t.toUpperCase().replace(/[\s-]/g, "");
  if (
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(compact) ||
    /^[0-9]{2}[0-9A-Z]{12,13}$/.test(compact)
  )
    return "gstin";
  if (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(compact)) return "pan";
  if (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(compact)) return "ifsc";
  if (/@/.test(t)) return "upi";
  const digits = t.replace(/[\s()-]/g, "");
  // A + or a 0 in front makes it a phone number; a bare 12-digit number is an Aadhaar number unless only
  // the +91 reading holds (an Aadhaar number can start with 91 too, so its checksum decides).
  if (/^\+/.test(digits) || /^0[6-9]\d{9}$/.test(digits)) return "mobile";
  if (/^[0-9]{12}$/.test(digits))
    return /^91[6-9][0-9]{9}$/.test(digits) && !verhoeff(digits) ? "mobile" : "aadhaar";
  if (/^[6-9][0-9]{9}$/.test(digits)) return "mobile";
  if (/^[1-9][0-9]{5}$/.test(digits)) return "pin";
  return null;
}

const CHECKS = {
  pan: checkPan,
  gstin: checkGstin,
  ifsc: checkIfsc,
  pin: checkPin,
  upi: checkUpi,
  mobile: checkMobile,
  aadhaar: checkAadhaar,
};

export async function run(input = {}) {
  const forced = String(input?.type ?? "").toLowerCase();
  const text = String(input?.value ?? input?.id ?? input?.text ?? input?.prompt ?? "");
  if (!text.trim())
    return {
      ok: false,
      error:
        "Give the number to check, for example a PAN, GSTIN, IFSC, PIN, UPI id or mobile number.",
    };
  const items = [];
  if (forced && CHECKS[forced]) items.push(CHECKS[forced](text));
  else {
    // Several identifiers in one message: check each separated word or token.
    const tokens = text
      .split(/[\n,;]+|\s+(?:and|aur|&)\s+/i)
      .map((s) => s.trim())
      .filter(Boolean);
    const candidates = tokens.length > 1 ? tokens : [text];
    for (const c of candidates) {
      const words = c.split(/\s+/);
      const whole = detect(c);
      if (whole) {
        items.push(CHECKS[whole](c));
        continue;
      }
      for (const w of words) {
        const kind = detect(w);
        if (kind) items.push(CHECKS[kind](w));
      }
    }
  }
  if (!items.length)
    return {
      ok: false,
      error:
        "Could not tell what kind of number this is. Say the type: PAN, GSTIN, IFSC, PIN, UPI, mobile or Aadhaar.",
    };
  return {
    ok: true,
    answer: items
      .map((r) => `${r.type} ${r.value}: ${r.valid ? "valid format" : `NOT valid - ${r.reason}`}`)
      .join("\n"),
    results: items,
    note: "A well-formed number is not proof that it is real, active or yours. Verify on the official portal before relying on it.",
  };
}

export default run;
