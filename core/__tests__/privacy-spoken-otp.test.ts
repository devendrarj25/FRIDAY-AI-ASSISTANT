/**
 * A code the owner says out loud reaches the model as words: digits spaced apart, digits as words, a number said the
 * way people say it ("teen sau bees"), the Devanagari spellings, and "the code is ...". Every one of those is a
 * SENSITIVE hard stop in the shared marker table, in the desktop firewall and in the kernel's reader alike, while
 * ordinary talk about codes and pins stays ordinary. The digits are built at run time so no code-like literal
 * sits in the source.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const require_ = createRequire(import.meta.url);
const firewall = require_("../../electron/privacy-firewall.cjs") as {
  classify: (content: string) => { level: string; reasons: string[] };
  guardEgress: (input: { model: unknown; content: string; connected: boolean }) => {
    hardStop: boolean;
  };
};

const six = ["4", "8", "2", "9", "1", "3"];
const spaced = six.join(" ");
const joined = six.join("");

const groupedA = joined.slice(0, 3);
const groupedB = joined.slice(3);

const SPOKEN_SENSITIVE = [
  `otp ${groupedA}-${groupedB}`,
  `otp (${joined})`,
  `OTP [${joined}]`,
  `use ${joined.slice(0, 4)} ${joined.slice(4)} as otp`,
  `use ${groupedA} ${groupedB} as the otp`,
  `the OTP that I received on my phone just now from the bank is ${joined}`,
  `bank ka code ${joined} hai`,
  `bank code ${joined} hai`,
  `bank ka code ${spaced} hai`,
  `code is ${spaced}`,
  `your code is ${spaced}`,
  `ओटीपी ${groupedA}-${groupedB}`,
  `ओटीपी (${joined})`,
  `बैंक का कोड ${joined} है`,
  `बैंक का ओटीपी जो अभी फोन पर आया है ${joined}`,
  `mera bank ka otp abhi phone par aaya hai ${joined}`,
  `कोड है ${spaced}`,
  `OTP ${spaced}`,
  `otp is ${spaced}`,
  "mera cvv teen sau bees hai",
  "cvv teen sau bees",
  `the code is ${joined}`,
  `your code is ${joined}`,
  `mera code ${joined} hai`,
  `your verification code is ${joined}`,
  `verification code ${joined}`,
  `security code: ${joined}`,
  `one time password ${spaced}`,
  "OTP four eight two nine one three",
  "passcode one two three four",
  "pin 1 2 3 4",
  "OTP four eight double two nine",
  `ओटीपी ${spaced}`,
  "ओटीपी चार आठ दो नौ एक तीन",
  "मेरा ओटीपी है चार आठ दो नौ एक तीन",
  "सीवीवी तीन सौ बीस है",
  "सीवीवी तीन सौ बीस",
  `सत्यापन कोड ${joined}`,
  `वेरिफिकेशन कोड ${joined}`,
  `मेरा कोड ${joined} है`,
  "पासकोड 1 2 3 4",
  "पासकोड एक दो तीन चार",
  `Your verification code for login is ${joined}`,
  `the OTP that I got is ${joined}`,
  `OTP aaya tha ${joined} use karo`,
  `ओटीपी आया था ${joined} इस्तेमाल करो`,
  `${joined} is your OTP for transaction of INR 5,000 at AMAZON. Do not share it`,
  `Use ${joined} as your OTP`,
  `OTP for txn of Rs 5,000 at Amazon is ${joined}. Valid for 10 minutes`,
];

const ORDINARY = [
  "bank ka code review kal hai",
  "the code is 4829 lines long",
  "the code compiles fine and the build passes on every machine today",
  "I scored 482913 points as a player",
  "bank ka code of conduct padhna hai",
  "बैंक का कोड रिव्यू कल है",
  "कोड ठीक चल रहा है",
  "the code is in main.cjs",
  "the code compiles fine",
  "the area code is 011",
  "the postal code is 110001",
  "my pin code is 110001",
  "mera pin code 110001 hai",
  "what is a verification code?",
  "verification code kya hai",
  "the verification code field is empty",
  "one two three four, testing the mic",
  "I need 3 items for 4 people",
  "call me at 5 5 5 1 2 3 4",
  "otp kab aayega",
  "mera pin kya hai",
  "सत्यापन कोड क्या होता है",
  "मेरा कोड ठीक चल रहा है",
  "ओटीपी कब आएगा",
  "pin number bhej do",
  "the verification code field is empty and the form shows an error today",
  "otp kab aayega mujhe batao jaldi",
  "what is an otp and how does it work in banking",
  "OTP support is open from 9 to 5",
  "the verification code expires after 10 minutes",
];

describe("spoken and spelled codes are SENSITIVE", () => {
  it.each(SPOKEN_SENSITIVE)("%s", (line) => {
    expect(firewall.classify(line).level).toBe("sensitive");
  });

  it("is a hard stop for a connected cloud model, never a prompt", () => {
    const model = { id: "cloud:test", type: "cloud", meta: { providerId: "test" } };
    for (const content of [`OTP ${spaced}`, `the code is ${joined}`, "ओटीपी चार आठ दो नौ एक तीन"]) {
      expect(firewall.guardEgress({ model, content, connected: true }).hardStop).toBe(true);
    }
  });
});

describe("the grouped-digit rows stay fast on long input", () => {
  it.each([
    "otp 1 ",
    "bank ka code ",
    "code is 4 8 ",
    "otp (",
    "ओटीपी 12-",
    `${"w ".repeat(9)}otp `,
  ])("%s", (unit) => {
    const text = unit.repeat(Math.ceil(32000 / unit.length)).slice(0, 32000);
    const start = performance.now();
    firewall.classify(text);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("ordinary talk about codes stays ordinary", () => {
  it.each(ORDINARY)("%s", (line) => {
    expect(firewall.classify(line).level).not.toBe("sensitive");
  });
});

describe("the table stays one table", () => {
  it("adds only plain rows, each with an id, a kind and a label, and no second copy in the firewall", () => {
    const table = JSON.parse(
      readFileSync(resolve(__dirname, "../../config/sensitive-markers.json"), "utf8"),
    ) as { markers: { id: string; kind: string; label: string }[] };
    const ids = table.markers.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["spoken-code", "spoken-code-hi", "code-phrase"]));
    const source = readFileSync(resolve(__dirname, "../../electron/privacy-firewall.cjs"), "utf8");
    expect(source).not.toMatch(/teen|ओटीपी|verification/);
  });
});
