"""FRIDAY Voice frontend: Roman Hinglish (English words stay Latin), numbers by neighbour word, rupees and units.

No model file and no network.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tts_frontend as fe  # noqa: E402


def say(text: str, hint: str = "hi") -> list[fe.Clause]:
    return fe.prepare(text, hint)


def joined(text: str, hint: str = "hi") -> str:
    return " ".join(c.text for c in say(text, hint))


# ---- English words in Roman Hinglish -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "kept", "gone"),
    [
        ("Kal subah gym jaana hai, alarm laga dena please.", ("alarm", "gym", "please"), "अलर्म"),
        ("Aaj temperature 32 degree hai.", ("temperature",), "तेंपेरतुरे"),
        ("Alarm 7:15 baje ke liye set hai.", ("Alarm", "set"), "सेत"),
        ("Thoda wait kijiye, main file search kar rahi hoon.", ("wait", "file", "search"), "वैत"),
        ("Aapki battery bahut kam hai, charger laga lijiye.", ("battery", "charger"), "बैटरी"),
    ],
)
def test_english_words_of_roman_hinglish_stay_in_latin_letters(text: str, kept: tuple[str, ...], gone: str) -> None:
    got = say(text)
    assert [c.lang for c in got] == ["hi"] * len(got)  # the Hindi voice reads the whole clause
    said = " ".join(c.text for c in got)
    for word in kept:
        assert word in said, said
    assert gone not in said
    assert re.search("[ऀ-ॿ]", said), said  # the Hindi words are in Devanagari


def test_the_hindi_words_of_roman_hinglish_are_spelt_the_way_people_write_them() -> None:
    assert joined("Kal subah gym jaana hai, alarm laga dena please.") == "कल सुबह gym जाना है, alarm लगा देना please."
    assert joined("Mujhe lagta hai yeh email kaafi zaroori hai.") == "मुझे लगता है यह email काफ़ी ज़रूरी है."


def test_a_mostly_hindi_roman_sentence_is_still_written_whole_in_devanagari() -> None:
    assert joined("kya aap meri madad kar sakte hain") == "क्या आप मेरी मदद कर सकते हैं."


def test_english_sentences_with_a_stray_hindi_word_are_left_alone() -> None:
    assert joined("Please open the main folder", "en") == "Please open the main folder."
    assert joined("Do you have the main file for the report", "en") == "Do you have the main file for the report."
    assert [c.lang for c in say("I will call you kal", "en")] == ["en"]


def test_other_strategies_leave_roman_hinglish_as_written() -> None:
    got = fe.prepare("Kal subah gym jaana hai, alarm laga dena please.", "hi", roman_strategy="latin-en")
    assert got[0].text == "Kal subah gym jaana hai, alarm laga dena please."
    assert got[0].lang == "en"


def test_roman_hinglish_streams_the_same_as_it_prepares() -> None:
    text = "Kal 3 April ko meeting hai. Aapka balance Rs. 750 hai. Aaj temperature 32 degree hai."
    whole = fe.prepare(text, "hi")
    pieces = list(fe.clauses(iter(re.findall(r".{1,5}", text, re.S)), "hi"))
    assert [(c.text, c.lang) for c in pieces] == [(c.text, c.lang) for c in whole]


# ---- numbers follow the neighbouring word --------------------------------------------------------------------------


def test_a_number_takes_the_language_of_the_word_after_it() -> None:
    assert joined("Kal 3 April ko meeting hai.") == "कल three April को मीटिंग है."  # April is English
    assert joined("Kal subah 6 baje uthna hai.") == "कल सुबह छह बजे उठना है."  # baje is Hindi
    assert joined("Aaj temperature 32 degree hai.") == "आज temperature thirty two degree है."


def test_a_number_with_no_word_after_it_takes_the_word_before_it() -> None:
    assert joined("The room is 405", "hi") == "The room is four hundred five."
    assert joined("कमरा नंबर 405") == "कमरा नंबर चार सौ पाँच."


def test_a_number_with_no_neighbour_takes_the_clause_language() -> None:
    assert joined("2026", "hi") == "दो हज़ार छब्बीस."
    assert joined("2026", "en") == "two thousand twenty six."


def test_a_hindi_word_the_lexicon_lacks_still_makes_the_number_hindi() -> None:
    assert joined("Aapke paas 12 nayi emails hain.") == "आपके पास बारह नई emails हैं."


# ---- rupees and units ----------------------------------------------------------------------------------------------


def test_rs_in_roman_hinglish_keeps_its_rupees() -> None:
    assert joined("Aapka balance Rs. 750 hai.") == "आपका balance seven hundred fifty rupees है."
    assert joined("Aapka balance Rs 750 hai.") == "आपका balance seven hundred fifty rupees है."
    assert joined("आपका बकाया Rs. 750 है।") == "आपका बकाया सात सौ पचास रुपये है."
    assert joined("It costs Rs. 500 today", "en") == "It costs five hundred rupees today."


@pytest.mark.parametrize(
    ("text", "said"),
    [
        ("The distance is 5 km from here.", "The distance is five kilometres from here."),
        ("This file is 2.5 GB in size.", "This file is two point five gigabytes in size."),
        ("It weighs 1 kg.", "It weighs one kilogram."),
        ("It weighs 3kg.", "It weighs three kilograms."),
        ("Speed is 60 km/h today", "Speed is sixty kilometres per hour today."),
        ("The delay is 20 ms", "The delay is twenty milliseconds."),
        ("Battery 20 percent left", "Battery twenty percent left."),
        ("A 512 MB card", "A five hundred twelve megabytes card."),
    ],
)
def test_units_are_spoken_as_words_in_english(text: str, said: str) -> None:
    assert joined(text, "en") == said


@pytest.mark.parametrize(
    ("text", "said"),
    [
        ("दूरी 5 km है।", "दूरी पाँच किलोमीटर है."),
        ("फ़ाइल 2.5 GB की है।", "फ़ाइल दो दशमलव पाँच गीगाबाइट की है."),
        ("वज़न 70 kg है।", "वज़न सत्तर किलोग्राम है."),
        ("बैटरी 20 percent बची है।", "बैटरी बीस प्रतिशत बची है."),
        ("रफ़्तार 60 km/h है।", "रफ़्तार साठ किलोमीटर प्रति घंटा है."),
    ],
)
def test_units_are_spoken_as_words_in_hindi(text: str, said: str) -> None:
    assert joined(text) == said


def test_a_unit_word_is_not_taken_from_the_middle_of_a_word() -> None:
    assert joined("Open 5 kmart stores", "en") == "Open five kmart stores."
    assert joined("room 5 mbox", "en") == "room five mbox."


def test_expand_numbers_keeps_the_language_it_is_given_and_reads_units() -> None:
    assert fe.expand_numbers("5 km", "en").strip() == "five kilometres"
    assert fe.expand_numbers("5 km", "hi").strip() == "पाँच किलोमीटर"
    assert fe.expand_numbers("Rs. 750", "hi").strip() == "सात सौ पचास रुपये"
    assert fe.expand_numbers("20%", "en").strip() == "twenty percent"
