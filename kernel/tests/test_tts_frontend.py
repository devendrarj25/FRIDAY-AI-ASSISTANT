# ruff: noqa: S311 - seeded test data, not a secret
"""FRIDAY Voice frontend: clause cutting, characters, numbers, Roman Hindi, cache keys, acknowledgements, streaming.

No model file and no network: the character table is a small stand-in list.
"""

from __future__ import annotations

import hashlib
import random
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tts_frontend as fe  # noqa: E402


def texts(clauses: list[fe.Clause]) -> list[str]:
    return [c.text for c in clauses]


def fake_indexer(extra: str = "") -> list[int]:
    """A character table that knows ASCII letters and marks, Devanagari and whatever ``extra`` names."""
    table = [-1] * 0x1000
    known = set(map(ord, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?'\"-()%$&+/₹"))
    known |= set(range(0x0900, 0x0980)) | set(map(ord, extra))
    size = max(known) + 1
    table = [-1] * size
    for index, code in enumerate(sorted(known)):
        table[code] = index
    return table


def fragments(text: str, rng: random.Random) -> list[str]:
    out, i = [], 0
    while i < len(text):
        step = rng.choice((1, 1, 2, 3, 5, 8, 13, 40))
        out.append(text[i : i + step])
        i += step
    return out


class ClauseBoundaryTests(unittest.TestCase):
    def test_sentences_are_clauses_with_their_pauses(self) -> None:
        got = fe.prepare("Hello there. How are you doing today? I am fine, thanks!")
        self.assertEqual(texts(got), ["Hello there.", "How are you doing today?", "I am fine, thanks!"])
        self.assertEqual([c.pause_ms for c in got], [240, 280, 240])

    def test_ellipsis_pause_and_text(self) -> None:
        got = fe.prepare("Well... okay then.")
        self.assertEqual(texts(got), ["Well...", "okay then."])
        self.assertEqual([c.pause_ms for c in got], [380, 240])
        self.assertEqual(fe.prepare("Wait\u2026 what")[0].text, "Wait...")

    def test_question_with_exclamation_keeps_both_marks(self) -> None:
        got = fe.prepare("Really!? Yes.")
        self.assertEqual(texts(got), ["Really!?", "Yes."])
        self.assertEqual(got[0].pause_ms, 280)

    def test_paragraph_pause_replaces_the_sentence_pause(self) -> None:
        got = fe.prepare("First part.\n\nSecond part.")
        self.assertEqual(texts(got), ["First part.", "Second part."])
        self.assertEqual([c.pause_ms for c in got], [420, 240])

    def test_a_single_line_break_ends_a_sentence_without_a_paragraph(self) -> None:
        got = fe.prepare("one line\nanother line")
        self.assertEqual(texts(got), ["one line.", "another line."])
        self.assertEqual([c.pause_ms for c in got], [240, 240])

    def test_abbreviations_do_not_end_a_sentence(self) -> None:
        got = fe.prepare("Dr. Singh met Mr. Rao at 5 p.m. today. See e.g. this one. J. K. Rowling wrote it.")
        self.assertEqual(len(got), 3)
        self.assertTrue(got[0].text.startswith("Dr. Singh met Mr. Rao"))
        self.assertEqual(got[2].text, "J. K. Rowling wrote it.")

    def test_decimals_thousands_and_times_do_not_end_a_sentence(self) -> None:
        got = fe.prepare("Value 3.14, price 1,000 at 10:30.")
        self.assertEqual(len(got), 1)
        self.assertNotIn("3.14", got[0].text)  # read as words, but never cut

    def test_a_terminator_inside_a_token_is_no_boundary(self) -> None:
        self.assertEqual(len(fe.prepare("Open example.com now and v1.2.3 too.")), 1)

    def test_danda_ends_a_sentence_and_reads_as_a_full_stop(self) -> None:
        got = fe.prepare("मैं घर जा रहा हूँ। फिर मिलेंगे॥ ठीक है")
        self.assertEqual(texts(got), ["मैं घर जा रहा हूँ.", "फिर मिलेंगे.", "ठीक है."])
        self.assertEqual([c.pause_ms for c in got], [240, 240, 240])

    def test_list_numbers_and_bullets_are_not_read(self) -> None:
        got = fe.prepare("1. apples\n2. pears\n- plums\n* figs")
        self.assertEqual(texts(got), ["apples.", "pears.", "plums.", "figs."])

    def test_empty_and_unreadable_text_give_no_clauses(self) -> None:
        for value in ("", "   \n\n ", "...", "😀😀", "**", "```\ncode\n```"):
            self.assertEqual(fe.prepare(value), [], value)
        self.assertEqual(fe.prepare(None), [])  # type: ignore[arg-type]

    def test_a_long_sentence_is_cut_at_commas_within_the_soft_limit(self) -> None:
        sentence = ", ".join(f"part number {i} of the long list of things" for i in range(8)) + "."
        self.assertGreater(len(sentence), fe.CLAUSE_SOFT_CHARS)
        got = fe.prepare(sentence, first_words=5)
        self.assertGreater(len(got), 2)
        for clause in got:
            self.assertLessEqual(len(clause.text), fe.CLAUSE_SOFT_CHARS)
        self.assertEqual(got[-1].pause_ms, 240)
        self.assertIn(110, [c.pause_ms for c in got[1:-1]])

    def test_a_long_piece_without_commas_is_cut_at_words_and_keeps_going(self) -> None:
        sentence = " ".join(f"word{chr(97 + i % 26)}{'x' * (i % 7)}" for i in range(60)) + "."
        got = fe.prepare(sentence)
        original = sentence.rstrip(".").split()
        rebuilt = " ".join(c.text.rstrip(".,") for c in got).split()
        self.assertEqual(rebuilt, original)  # no word cut, none lost
        for clause in got:
            self.assertLessEqual(len(clause.text), fe.CLAUSE_SOFT_CHARS)
        for clause in got[:-1]:
            self.assertTrue(clause.text.endswith(","), clause.text)
            self.assertEqual(clause.pause_ms, fe.PAUSE_MS["cut"])

    def test_a_junk_token_is_dropped(self) -> None:
        got = fe.prepare("Here is a blob " + "A" * 400 + " and the end.")
        self.assertEqual(texts(got), ["Here is a blob and the end."])

    def test_no_clause_is_longer_than_the_hard_cap(self) -> None:
        rng = random.Random(5)
        words = ["alpha", "be", "gamma,", "delta.", "epsilon", "z", "इस", "बात,", "है।", "42", "₹1,50,000", "3.5%"]
        for _ in range(60):
            text = " ".join(rng.choice(words) for _ in range(rng.randint(1, 160)))
            for clause in fe.prepare(text, first_words=rng.randint(1, 9)):
                self.assertLessEqual(len(clause.text), fe.CLAUSE_HARD_CHARS)
                self.assertEqual(clause.text, clause.text.strip())

    def test_words_survive_the_cutting(self) -> None:
        rng = random.Random(9)
        words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"]
        for _ in range(40):
            parts = []
            for _ in range(rng.randint(1, 80)):
                parts.append(rng.choice(words) + rng.choice(["", "", "", ",", ".", "?", ";"]))
            text = " ".join(parts)
            got = re.sub(r"[^a-z]", "", " ".join(texts(fe.prepare(text))).lower())
            self.assertEqual(got, re.sub(r"[^a-z]", "", text.lower()))


class FirstClauseTests(unittest.TestCase):
    LONG = "one two three four five six seven eight nine ten eleven twelve."

    def test_a_long_first_sentence_starts_with_a_short_clause(self) -> None:
        got = fe.prepare(self.LONG)
        self.assertEqual(texts(got), ["one two three four five,", "six seven eight nine ten eleven twelve."])
        self.assertEqual([c.first for c in got], [True, False])
        self.assertEqual(got[0].pause_ms, fe.PAUSE_MS["cut"])

    def test_a_sentence_of_nine_words_or_fewer_is_not_cut(self) -> None:
        got = fe.prepare("one two three four five six seven eight nine.")
        self.assertEqual(len(got), 1)
        self.assertTrue(got[0].first)

    def test_a_comma_between_the_third_and_sixth_word_is_the_cut(self) -> None:
        got = fe.prepare("Well I think, that we should go to the market now.")
        self.assertEqual(texts(got)[0], "Well I think,")
        self.assertEqual(got[0].pause_ms, fe.PAUSE_MS["comma"])

    def test_a_comma_after_the_second_word_is_too_early(self) -> None:
        got = fe.prepare("Haan boss, aapka meeting kal subah ten baje hai aur main yaad dilaungi.")
        self.assertEqual(len(got[0].text.split()), 5)

    def test_first_words_is_honoured_and_clamped(self) -> None:
        for asked, expected in ((3, 3), (4, 4), (6, 6), (1, 3), (12, 6)):
            got = fe.prepare(self.LONG, first_words=asked)
            self.assertEqual(len(got[0].text.split()), expected, asked)

    def test_the_cut_does_not_end_on_a_word_that_cannot_end_a_phrase(self) -> None:
        got = fe.prepare(
            "please send the report to the team before the meeting starts tomorrow morning.", first_words=5
        )
        self.assertEqual(got[0].text, "please send the report to the team,")

    def test_only_the_first_clause_is_first(self) -> None:
        got = fe.prepare("Hi there. " + self.LONG + " More text here.")
        self.assertEqual([c.first for c in got], [True] + [False] * (len(got) - 1))

    def test_only_the_first_sentence_gets_a_short_first_clause(self) -> None:
        got = fe.prepare("Short one. " + self.LONG)
        self.assertEqual(len(got), 2)
        self.assertEqual(got[1].text, self.LONG)


class CharacterTests(unittest.TestCase):
    def test_markdown_is_removed(self) -> None:
        got = fe.prepare("# Title\n\n**Bold** and *italic* and `code` here.\n\n> quoted\n\n---\n\nEnd.")
        self.assertEqual(texts(got), ["Title.", "Bold and italic and code here.", "quoted.", "End."])

    def test_a_code_fence_is_dropped_without_a_paragraph_gap(self) -> None:
        got = fe.prepare("Run this:\n```python\nx = 1. y\n```\nThen stop.")
        self.assertEqual(texts(got), ["Run this:", "Then stop."])
        self.assertEqual(got[0].pause_ms, 240)

    def test_an_open_code_fence_drops_the_rest(self) -> None:
        self.assertEqual(texts(fe.prepare("Before.\n```\nnever read")), ["Before."])

    def test_links_keep_the_label_and_lose_the_address(self) -> None:
        got = fe.prepare("See [the guide](https://example.com/a.b?x=1) or https://example.com/path. Done.")
        self.assertEqual(texts(got), ["See the guide or.", "Done."])

    def test_emoji_and_pictographs_are_removed(self) -> None:
        self.assertEqual(texts(fe.prepare("Great 😀 job 👍🏽 team ✅ ok")), ["Great job team ok."])

    def test_accents_fold_to_the_plain_letter(self) -> None:
        self.assertEqual(texts(fe.prepare("café naïve")), ["cafe naive."])

    def test_quotes_and_dashes_are_plain(self) -> None:
        got = fe.prepare("\u201cHello\u201d \u2014 she said\u2026 it\u2019s fine")
        self.assertEqual(texts(got), ['"Hello", she said...', "it's fine."])

    def test_characters_the_table_does_not_know_are_removed(self) -> None:
        table = fake_indexer()
        got = fe.prepare("Hello \u4f60\u597d world \u2603 ok", indexer=table)
        self.assertEqual(texts(got), ["Hello world ok."])

    def test_a_table_with_extra_letters_keeps_them_and_marks_the_clause_unknown(self) -> None:
        table = fake_indexer("привет")
        got = fe.prepare("привет", indexer=table)
        self.assertEqual(texts(got), ["привет."])
        self.assertEqual(got[0].lang, "na")

    def test_without_a_table_the_built_in_safe_set_is_used(self) -> None:
        self.assertEqual(texts(fe.prepare("Hello \u4f60\u597d world \u2603 ok")), ["Hello world ok."])

    def test_devanagari_digits_become_numbers(self) -> None:
        self.assertEqual(texts(fe.prepare("मुझे ७ सेब चाहिए")), ["मुझे सात सेब चाहिए."])

    def test_nukta_letters_stay_readable_with_a_table(self) -> None:
        got = fe.prepare("ज़रूर फ़ोन", indexer=fake_indexer())
        self.assertEqual(texts(got), ["ज़रूर फ़ोन."])

    def test_engine_clean_text_does_not_change_a_clause(self) -> None:
        try:
            import friday_voice
        except ImportError:  # numpy is not installed here
            return
        samples = [
            "Hello there. How are you? 25% of ₹5,000 is done.",
            "मैं घर जा रहा हूँ। आप कहाँ हैं?",
            "Haan boss, aapka meeting kal subah ten baje hai, main reminder laga deti hu.",
            "**Bold** [link](http://x.y/z) 😀 end",
        ]
        for sample in samples:
            for clause in fe.prepare(sample, indexer=None):
                self.assertEqual(friday_voice.clean_text(clause.text), clause.text)


class LanguageTests(unittest.TestCase):
    def test_script_decides_the_language(self) -> None:
        got = fe.prepare("Hello there. मैं ठीक हूँ।")
        self.assertEqual([c.lang for c in got], ["en", "hi"])

    def test_a_letterless_clause_follows_the_hint(self) -> None:
        self.assertEqual(fe.prepare("2026", lang_hint="hi-IN")[0].lang, "hi")
        self.assertEqual(fe.prepare("2026", lang_hint="hinglish")[0].lang, "hi")
        self.assertEqual(fe.prepare("2026", lang_hint="en-US")[0].lang, "en")
        self.assertEqual(fe.prepare("2026")[0].lang, "en")

    def test_an_english_word_inside_hindi_stays_in_the_hindi_clause(self) -> None:
        got = fe.prepare("मुझे कल meeting में जाना है")
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0].lang, "hi")
        self.assertEqual({s.lang for s in got[0].spans}, {"hi"})

    def test_a_clause_with_two_real_languages_keeps_both_spans(self) -> None:
        got = fe.prepare("मुझे जाना है because the road is closed")
        self.assertEqual(len(got), 1)
        self.assertEqual({s.lang for s in got[0].spans}, {"hi", "en"})
        self.assertEqual(got[0].lang, "hi")  # the Hindi voice reads the English words of a Hindi sentence

    def test_english_with_one_hindi_word_stays_english(self) -> None:
        got = fe.prepare("Please open the big red file now जी")
        self.assertEqual(got[0].lang, "en")

    def test_hindi_wins_while_the_english_words_are_at_most_twice_the_hindi_ones(self) -> None:
        self.assertEqual(fe.prepare("Open Chrome और report भेजो")[0].lang, "hi")  # 3 English, 2 Hindi
        self.assertEqual(fe.prepare("one two three four क")[0].lang, "en")  # 4 English, 1 Hindi
        self.assertEqual(fe.prepare("one two क")[0].lang, "hi")  # 2 English, 1 Hindi

    def test_the_mixed_policy_can_choose_the_unknown_language(self) -> None:
        with mock.patch.object(fe, "MIXED_POLICY", "na"):
            got = fe.prepare("मुझे जाना है because the road is closed")
        self.assertEqual(got[0].lang, "na")

    def test_the_mixed_policy_can_follow_the_larger_script(self) -> None:
        with mock.patch.object(fe, "MIXED_POLICY", "dominant"):
            self.assertEqual(fe.prepare("मुझे जाना है because the road is closed")[0].lang, "en")
            self.assertEqual(fe.prepare("मुझे कल meeting में जाना है")[0].lang, "hi")

    def test_every_clause_language_is_known(self) -> None:
        for sample in ("Hi.", "नमस्ते।", "Open Chrome और report भेजो", "mujhe paani chahiye", "42"):
            for clause in fe.prepare(sample):
                self.assertIn(clause.lang, fe.SPEECH_LANGS)


class RomanHindiTests(unittest.TestCase):
    def test_detection_needs_common_hindi_words(self) -> None:
        self.assertTrue(fe.is_roman_hindi("mujhe thoda paani chahiye, aap kaise ho"))
        self.assertTrue(fe.is_roman_hindi("kya aap abhi ghar ja rahe ho"))
        self.assertFalse(fe.is_roman_hindi("Do you have the main file for the report"))
        self.assertFalse(fe.is_roman_hindi("Hello there"))
        self.assertFalse(fe.is_roman_hindi("haan"))

    def test_the_default_writes_roman_hindi_in_devanagari_for_the_hindi_voice(self) -> None:
        got = fe.prepare("kya aap meri madad kar sakte hain")
        self.assertEqual(got[0].lang, "hi")
        self.assertEqual(got[0].text, "क्या आप मेरी मदद कर सकते हैं.")

    def test_a_short_roman_hindi_clause_is_found_by_words_with_no_english_reading(self) -> None:
        self.assertTrue(fe.is_roman_hindi("theek hai"))
        self.assertEqual(texts(fe.prepare("theek hai")), ["ठीक है."])
        self.assertEqual(texts(fe.prepare("kal meeting hai")), ["कल मीटिंग है."])

    def test_the_switch_constant_names_the_default(self) -> None:
        self.assertIn(fe.ROMAN_HINDI_STRATEGY, fe.ROMAN_HINDI_STRATEGIES)

    def test_each_strategy_has_its_language(self) -> None:
        text = "aap kaise ho aaj"
        expected = {"devanagari": "hi", "latin-en": "en", "latin-na": "na", "latin-hi": "hi"}
        for strategy, lang in expected.items():
            got = fe.prepare(text, roman_strategy=strategy)
            self.assertEqual(got[0].lang, lang, strategy)
            if strategy == "devanagari":
                self.assertFalse(re.search("[A-Za-z]", got[0].text))
            else:
                self.assertEqual(got[0].text, "aap kaise ho aaj.")

    def test_an_unknown_strategy_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            fe.prepare("aap kaise ho", roman_strategy="guess")

    def test_english_sentences_are_never_converted(self) -> None:
        self.assertEqual(texts(fe.prepare("Please open the main folder")), ["Please open the main folder."])

    def test_a_devanagari_sentence_with_latin_words_is_not_roman_hindi(self) -> None:
        got = fe.prepare("आप कहाँ हैं और main folder खोलो")
        self.assertIn("main", got[0].text)

    def test_roman_to_devanagari_uses_the_table_then_the_rules(self) -> None:
        self.assertEqual(fe.roman_to_devanagari("hain"), "हैं")
        self.assertEqual(fe.roman_to_devanagari("kitaab"), "किताब")
        self.assertEqual(
            fe.roman_to_devanagari("aap 5 baje, Rahul!"), "आप 5 बजे, " + fe.roman_to_devanagari("Rahul") + "!"
        )
        self.assertEqual(fe.roman_to_devanagari("नमस्ते hai"), "नमस्ते है")


class NumberTests(unittest.TestCase):
    def test_hindi_table_has_one_hundred_words(self) -> None:
        self.assertEqual(len(fe.HI_NUMBERS), 100)
        self.assertEqual((fe.HI_NUMBERS[0], fe.HI_NUMBERS[7], fe.HI_NUMBERS[21], fe.HI_NUMBERS[99]),
                         ("शून्य", "सात", "इक्कीस", "निन्यानवे"))  # fmt: skip

    def test_english_numbers_use_the_indian_grouping(self) -> None:
        cases = {0: "zero", 7: "seven", 21: "twenty one", 100: "one hundred", 105: "one hundred five",
                 1234: "one thousand two hundred thirty four", 100000: "one lakh",
                 12345678: "one crore twenty three lakh forty five thousand six hundred seventy eight"}  # fmt: skip
        for value, words in cases.items():
            self.assertEqual(fe.say_number(value, "en"), words)

    def test_hindi_numbers_use_sau_hazaar_lakh_crore(self) -> None:
        self.assertEqual(fe.say_number(0, "hi"), "शून्य")
        self.assertEqual(fe.say_number(100, "hi"), "एक सौ")
        self.assertEqual(fe.say_number(1234, "hi"), "एक हज़ार दो सौ चौंतीस")
        self.assertEqual(fe.say_number(150000, "hi"), "एक लाख पचास हज़ार")
        self.assertEqual(fe.say_number(12345678, "hi"), "एक करोड़ तेईस लाख पैंतालीस हज़ार छह सौ अठहत्तर")

    def test_numbers_in_a_hindi_clause_are_hindi_words(self) -> None:
        self.assertEqual(texts(fe.prepare("मेरे पास 3 सेब हैं")), ["मेरे पास तीन सेब हैं."])

    def test_numbers_in_an_english_clause_are_english_words(self) -> None:
        self.assertEqual(texts(fe.prepare("I have 3 apples")), ["I have three apples."])

    def test_percent_and_currency(self) -> None:
        self.assertEqual(texts(fe.prepare("A 25% rise")), ["A twenty five percent rise."])
        self.assertEqual(texts(fe.prepare("कीमत ₹1,50,000 है और 25% छूट")),
                         ["कीमत एक लाख पचास हज़ार रुपये है और पच्चीस प्रतिशत छूट."])  # fmt: skip
        self.assertEqual(texts(fe.prepare("It costs Rs. 500 today")), ["It costs five hundred rupees today."])
        self.assertEqual(texts(fe.prepare("Pay $20 now")), ["Pay twenty dollars now."])

    def test_decimals_read_digit_by_digit_after_the_point(self) -> None:
        self.assertEqual(texts(fe.prepare("pi is 3.14")), ["pi is three point one four."])
        self.assertEqual(texts(fe.prepare("यह 2.5 है")), ["यह दो दशमलव पाँच है."])

    def test_clock_times(self) -> None:
        self.assertEqual(texts(fe.prepare("Meet at 10:30")), ["Meet at ten thirty."])
        self.assertEqual(texts(fe.prepare("Meet at 10:00")), ["Meet at ten o'clock."])
        self.assertEqual(texts(fe.prepare("मिलते हैं 10:00")), ["मिलते हैं दस बजे."])

    def test_ids_phone_numbers_and_leading_zeros_are_read_digit_by_digit(self) -> None:
        self.assertEqual(texts(fe.prepare("Call 9876543210"))[0].split()[:3], ["Call", "nine", "eight"])
        self.assertEqual(texts(fe.prepare("room 007")), ["room zero zero seven."])
        self.assertEqual(texts(fe.prepare("id 1234567890123")[:1])[0].split()[1:3], ["one", "two"])

    def test_a_clause_of_digits_alone_follows_the_hint(self) -> None:
        self.assertEqual(texts(fe.prepare("2026", lang_hint="hi")), ["दो हज़ार छब्बीस."])
        self.assertEqual(texts(fe.prepare("2026")), ["two thousand twenty six."])

    def test_numbers_that_make_a_clause_too_long_are_cut_again(self) -> None:
        text = " ".join(["1234567"] * 20) + "."
        for clause in fe.prepare(text):
            self.assertLessEqual(len(clause.text), fe.CLAUSE_HARD_CHARS)
        self.assertGreater(len(fe.prepare(text)), 1)

    def test_digits_stuck_to_letters_are_still_spoken(self) -> None:
        self.assertEqual(texts(fe.prepare("mp3 file")), ["mp three file."])


class KeyTests(unittest.TestCase):
    def test_the_key_is_a_stable_sha256_of_the_fields(self) -> None:
        key = fe.clause_key("Hello there.", "en", "friday-1", 3, 1.0)
        expected = hashlib.sha256(b"Hello there.\x1fen\x1ffriday-1\x1f3\x1f1.000").hexdigest()
        self.assertEqual(key, expected)
        self.assertEqual(len(key), 64)

    def test_every_field_changes_the_key(self) -> None:
        keys = {
            fe.clause_key("Hello there.", "en", "v", "1", 1.0),
            fe.clause_key("Hello there!", "en", "v", "1", 1.0),
            fe.clause_key("Hello there.", "hi", "v", "1", 1.0),
            fe.clause_key("Hello there.", "en", "w", "1", 1.0),
            fe.clause_key("Hello there.", "en", "v", "2", 1.0),
            fe.clause_key("Hello there.", "en", "v", "1", 1.1),
        }
        self.assertEqual(len(keys), 6)

    def test_spacing_and_speed_spelling_do_not_change_the_key(self) -> None:
        self.assertEqual(fe.clause_key("a  b\n c", "en", "v", 1, 1), fe.clause_key("a b c", "en", "v", "1", 1.0))
        self.assertEqual(fe.clause_key("x", "en", "v", 1, 1.0004), fe.clause_key("x", "en", "v", 1, 1.0))

    def test_a_composed_and_a_decomposed_letter_share_a_key(self) -> None:
        self.assertEqual(fe.clause_key("\u00e9", "en", "v", 1, 1), fe.clause_key("e\u0301", "en", "v", 1, 1))


class AcknowledgementTests(unittest.TestCase):
    def test_ids_are_unique_and_every_group_is_present(self) -> None:
        ids = [a.id for a in fe.ACKS]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual({a.group for a in fe.ACKS}, {"hi", "en", "hinglish"})
        self.assertGreaterEqual(len(fe.ACKS), 25)

    def test_the_planned_phrases_are_there(self) -> None:
        wanted = {"हाँ।", "जी।", "ठीक है।", "एक सेकंड।", "हम्म।", "समझ गई।"}
        have = {a.text.replace(".", "।") for a in fe.ACKS if a.group == "hi"}
        self.assertTrue(wanted <= have)

    def test_each_phrase_is_one_clause_with_the_stated_language(self) -> None:
        for item in fe.ACKS:
            made = fe.prepare(item.text)
            self.assertEqual(len(made), 1, item.id)
            self.assertEqual(made[0].text, item.text, item.id)
            self.assertEqual(made[0].lang, item.lang, item.id)
            self.assertLessEqual(len(item.text), 40)

    def test_lookup_and_clause(self) -> None:
        self.assertEqual(fe.ack("hi-haan").text, "हाँ.")
        with self.assertRaises(KeyError):
            fe.ack("nope")
        clause = fe.ack_clause("en-sure", first=False)
        self.assertEqual((clause.text, clause.lang, clause.first), ("Sure.", "en", False))
        self.assertTrue(fe.ack_clause("en-sure").first)


class StreamingTests(unittest.TestCase):
    SAMPLES = [
        "Hello there. How are you doing today? I am fine, thanks! Dr. Singh is here at 5 p.m. sharp.",
        "मैं घर जा रहा हूँ। आप कहाँ हैं? कीमत ₹1,50,000 है और 25% छूट। ठीक है॥ फिर मिलेंगे।",
        "# Title\n\n**Bold** text with a [link](https://x.y/a.b) and https://example.com/q. "
        "Next 😀 line\n\n- one\n- two\n",
        "Run this:\n```python\nx = 1. y\n```\nThen stop. And more text after the fence, which is long enough to need "
        "the cutting rules because it keeps going on and on, with commas, and without any real end in sight, "
        "until at last it does end here.",
        "Haan boss, aapka meeting kal subah ten baje hai, main reminder laga deti hu. "
        "kya aap meri madad kar sakte hain",
        "one two three four five six seven eight nine ten eleven twelve thirteen fourteen. Short.",
        "Wait... what?! Really?\n\nYes.\nNo\n\n\nMaybe 3.14 or 1,000 or 10:30. Mixed मुझे कल meeting में जाना है।",
        "x " * 150 + "end.",
        "Call 9876543210 now; cost $5.50, not 12%.  Spaces   everywhere \t and\ttabs.\r\nWindows line.\r\nDone",
    ]

    def test_fragments_give_the_same_clauses_as_the_whole_text(self) -> None:
        for sample in self.SAMPLES:
            whole = fe.prepare(sample, lang_hint="hi")
            self.assertEqual(list(fe.clauses(list(sample), lang_hint="hi")), whole, sample[:30])
            self.assertEqual(list(fe.clauses([sample], lang_hint="hi")), whole)

    def test_random_fragmentation_is_the_same_as_the_whole_text(self) -> None:
        for number, sample in enumerate(self.SAMPLES):
            whole = fe.prepare(sample, first_words=4)
            for seed in range(25):
                rng = random.Random(number * 1000 + seed)
                got = list(fe.clauses(fragments(sample, rng), first_words=4))
                self.assertEqual(got, whole, f"sample {number} seed {seed}")

    def test_random_texts_fragment_independently(self) -> None:
        rng = random.Random(77)
        pool = ["Hello", "world.", "Dr.", "Singh", "है।", "मैं", "ok,", "3.14", "5", "p.m.", "what?", "\n", "\n\n",
                "**x**", "😀", "aap", "kaise", "ho,", "...", "#", "```", "[a](http://b.c)", "₹5", ";", "-", "—",
                "a\u200db", "x" * 90, "1,00,000", "10:30", "25%"]  # fmt: skip
        for _ in range(150):
            text = " ".join(rng.choice(pool) for _ in range(rng.randint(1, 45)))
            whole = fe.prepare(text)
            got = list(fe.clauses(fragments(text, rng)))
            self.assertEqual(got, whole, repr(text))

    def test_character_soup_never_breaks_the_clause_rules_or_the_fragment_rule(self) -> None:
        rng = random.Random(21)
        alphabet = [
            chr(c) for c in [*range(32, 127), *range(0x900, 0x980), 10, 10, 13, 9, 0x2026, 0x1F600, 0xE9, 0x200D, 0xA0]
        ]
        for _ in range(250):
            text = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 220)))
            whole = fe.prepare(text)
            for clause in whole:
                self.assertTrue(0 < len(clause.text) <= fe.CLAUSE_HARD_CHARS)
                self.assertEqual(clause.text, clause.text.strip())
                self.assertIn(clause.lang, fe.SPEECH_LANGS)
            self.assertEqual(list(fe.clauses(fragments(text, rng))), whole, repr(text))

    def test_a_standalone_hyphen_is_a_pause_and_a_hyphenated_word_is_one_word(self) -> None:
        self.assertEqual(texts(fe.prepare("wait - what")), ["wait, what."])
        self.assertEqual(texts(fe.prepare("a well-known fact")), ["a well-known fact."])
        self.assertEqual(texts(fe.prepare("0 -")), ["zero,"])

    def test_windows_line_breaks_and_tabs(self) -> None:
        got = fe.prepare("Line one.\r\nLine\ttwo.\r\n\r\nLine three")
        self.assertEqual(texts(got), ["Line one.", "Line two.", "Line three."])
        self.assertEqual([c.pause_ms for c in got], [240, 420, 240])

    def test_a_junk_token_keeps_the_marks_that_followed_it(self) -> None:
        self.assertEqual(texts(fe.prepare("see " + "z" * 100 + ", then go")), ["see, then go."])

    def test_a_heading_mark_and_a_dash_do_not_depend_on_where_the_text_was_cut(self) -> None:
        for pieces in (["# - p"], ["# ", "- p"], ["#", " ", "-", " p"]):
            self.assertEqual(texts(list(fe.clauses(pieces))), texts(fe.prepare("# - p")))

    def test_a_clause_comes_out_once_the_next_sentence_has_begun(self) -> None:
        planner = fe._Planner("", 5, None, None)
        self.assertEqual(planner.feed("Hello there"), [])
        self.assertEqual(planner.feed("."), [])  # the next character may still say it was an abbreviation
        self.assertEqual(texts(planner.feed(" How ")), ["Hello there."])
        self.assertEqual(planner.feed("are you? Fine"), [])  # "are you?" is not decided until a word follows
        self.assertEqual(texts(planner.feed(" ")), ["How are you?"])
        self.assertEqual(texts(planner.finish()), ["Fine."])

    def test_the_first_clause_does_not_wait_for_a_long_sentence_to_end(self) -> None:
        planner = fe._Planner("", 5, None, None)
        got: list[fe.Clause] = []
        for word in "one two three four five six seven eight nine ten eleven twelve ".split():
            got += planner.feed(word + " ")
            if got:
                break
        self.assertEqual(texts(got), ["one two three four five,"])
        self.assertTrue(got[0].first)

    def test_the_tail_is_kept_until_it_is_closed_or_the_text_ends(self) -> None:
        pieces = ["First sentence. ", "Second one is ", "still going", " on", ".", " Third"]
        stream = fe.clauses(iter(pieces))
        self.assertEqual(next(stream).text, "First sentence.")
        self.assertEqual(next(stream).text, "Second one is still going on.")
        self.assertEqual(next(stream).text, "Third.")
        with self.assertRaises(StopIteration):
            next(stream)

    def test_empty_and_missing_fragments_are_ignored(self) -> None:
        self.assertEqual(texts(list(fe.clauses(["", "Hi", None, " there.", ""]))), ["Hi there."])  # type: ignore[list-item]
        self.assertEqual(list(fe.clauses([])), [])

    def test_a_split_code_fence_and_a_split_url_are_still_removed(self) -> None:
        pieces = ["Before.\n``", "`py\nx = 1\n``", "`\nAfter see http", "s://exam", "ple.com/a now."]
        got = list(fe.clauses(pieces))
        self.assertEqual(texts(got), ["Before.", "After see now."])

    def test_clauses_are_stable_when_prepared_again(self) -> None:
        for sample in self.SAMPLES[:7]:
            for clause in fe.prepare(sample):
                again = " ".join(texts(fe.prepare(clause.text)))
                self.assertEqual(again.replace(",", ""), clause.text.replace(",", ""))


if __name__ == "__main__":
    unittest.main()
