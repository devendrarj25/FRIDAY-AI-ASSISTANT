"""The kernel reader classifies the spoken and spelled codes exactly like the desktop firewall does.

The lines mirror core/__tests__/privacy-spoken-otp.test.ts; the digits are built at run time so no code-like
literal sits in the source.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import privacy

SIX = ["4", "8", "2", "9", "1", "3"]
SPACED = " ".join(SIX)
JOINED = "".join(SIX)

SPOKEN_SENSITIVE = [
    f"OTP {SPACED}",
    f"otp is {SPACED}",
    "mera cvv teen sau bees hai",
    "cvv teen sau bees",
    f"the code is {JOINED}",
    f"your code is {JOINED}",
    f"mera code {JOINED} hai",
    f"your verification code is {JOINED}",
    f"verification code {JOINED}",
    f"security code: {JOINED}",
    f"one time password {SPACED}",
    "OTP four eight two nine one three",
    "passcode one two three four",
    "pin 1 2 3 4",
    "OTP four eight double two nine",
    f"ओटीपी {SPACED}",
    "ओटीपी चार आठ दो नौ एक तीन",
    "मेरा ओटीपी है चार आठ दो नौ एक तीन",
    "सीवीवी तीन सौ बीस है",
    "सीवीवी तीन सौ बीस",
    f"सत्यापन कोड {JOINED}",
    f"वेरिफिकेशन कोड {JOINED}",
    f"मेरा कोड {JOINED} है",
    "पासकोड 1 2 3 4",
    "पासकोड एक दो तीन चार",
]

ORDINARY = [
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
]


@pytest.mark.parametrize("line", SPOKEN_SENSITIVE)
def test_spoken_code_lines_are_sensitive(line):
    assert privacy.classify(line)["level"] == "sensitive"


@pytest.mark.parametrize("line", ORDINARY)
def test_ordinary_code_talk_is_not_sensitive(line):
    assert privacy.classify(line)["level"] != "sensitive"
