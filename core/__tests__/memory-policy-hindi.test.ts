/**
 * The SENSITIVE classifier reads Hindi and Hinglish too: one marker table, no second list.
 * A Devanagari or Roman Hindi secret must not slip past it because the English markers cannot see it.
 */
import { describe, expect, it } from "vitest";
import { looksSensitive } from "../../src/lib/friday/brain/memory-policy";

describe("Hindi and Hinglish secrets are SENSITIVE", () => {
  it.each([
    // Devanagari
    "मेरा पासवर्ड abc123 है",
    "ओटीपी 553920 आया है",
    "मेरा पिन 4821 है",
    "सीवीवी 123 है",
    "बैंक खाता संख्या 123456789012",
    "खाता नंबर 1234567890 है",
    "आधार कार्ड नंबर 1234 5678 9012",
    "एपीआई कुंजी sk-test",
    "पासकोड 7391 रखा था",
    "यह गुप्त कोड x7k29 है",
    "paasword hunter2 hai mera",
    "mera pin 7391 hai",
    "mera aadhaar number 123456789012 bhejo",
    "pan card number ABCDE1234F bhejo",
    // Roman Hindi (Hinglish)
    "mera paasword hunter2 hai",
    "mera otp 553920 hai",
    "otp hai 553920",
    "khata number 1234567890",
  ])("%s", (line) => {
    expect(looksSensitive(line)).toBe(true);
  });

  it("a 4-digit PIN question is sensitive in both scripts", () => {
    expect(looksSensitive("क्या मेरा पिन 4821 सही है?")).toBe(true);
    expect(looksSensitive("is my pin 4821 correct?")).toBe(true);
    expect(looksSensitive("mera pin 4821 hai")).toBe(true);
  });
});

// A bare Hindi or Roman Hindi word with no value (a question, a request, a story) is ordinary:
// the same value-required rule as the English rows, so the quick lane and drafts stay on.
describe("ordinary Hindi and Hinglish is not SENSITIVE", () => {
  it.each([
    "कौन सा दिन है आज",
    "क्या समय हुआ है",
    "इसका आधार क्या है",
    "गुप्ता जी कल आएँगे",
    "टोकनाइज़ेशन क्या होता है",
    "इस संदेश को पिन करो",
    "एपीआई क्या होता है",
    "aaj mausam kaisa hai",
    "kya time hua hai",
    "mera naam Rahul hai",
    "kal ka khana kya hai",
    "bank jaana hai kal",
    "पासकोड क्या रखा था",
    "मेरा पिन क्या है?",
    "मेरा क्रेडिट कार्ड खो गया",
    "डेबिट कार्ड की जानकारी बताओ",
    "कार्ड नंबर भेज दो",
    "मेरा आधार बताओ",
    "पैन कार्ड नंबर क्या है",
    "यह गुप्त कोड है",
    "सीक्रेट कोड मत बताना",
    "paasword kya hai mera",
    "mera pin kya hai",
    "pin number bhej do",
    "mera aadhaar number bhejo",
    "aadhar card number kya hai",
    "credit card ka number batao",
    "mere debit card ka pin",
    "ATM pin yaad hai?",
    "pan card number bhejo",
  ])("%s", (line) => {
    expect(looksSensitive(line)).toBe(false);
  });

  it("a 6-digit PIN code line is a postal code, not a secret (decided here)", () => {
    expect(looksSensitive("मेरा पिन कोड 110001 है")).toBe(false);
    expect(looksSensitive("पिन कोड 110001 कहाँ का है?")).toBe(false);
    expect(looksSensitive("pin code 110001 kahan ka hai")).toBe(false);
    expect(looksSensitive("Delhi pin code 110001")).toBe(false);
    expect(looksSensitive("mera pin code 110001 hai")).toBe(false);
  });

  it("a 4-digit number after a pin code is not a postal code, so it stays sensitive", () => {
    expect(looksSensitive("मेरा पिन कोड 4821 है")).toBe(true);
  });

  it("the English rules are unchanged", () => {
    expect(looksSensitive("my password is hunter2")).toBe(true);
    expect(looksSensitive("how do I reset my password?")).toBe(false);
    expect(looksSensitive("what is an OTP?")).toBe(false);
  });
});
