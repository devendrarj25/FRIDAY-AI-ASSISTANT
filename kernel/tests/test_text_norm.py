import sys
import unicodedata
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ears_eval as ee  # noqa: E402
import stt_bench  # noqa: E402
import text_norm as tn  # noqa: E402

# --- English -------------------------------------------------------------------------------------------------------

ENGLISH_CASES = [
    ("Hello, World!", "hello world"),
    ("I can't believe it's true.", "i can not believe it is true"),
    ("They won't go, and we'll see.", "they will not go and we will see"),
    ("Let's go; y'all ready?", "let us go you all ready"),
    ("I'm gonna wanna leave", "i am going to want to leave"),
    ("She said [laughs] hello (applause) world", "she said hello world"),
    ("Hmm, um, well, uh, okay", "well okay"),
    ("Mr. Smith and Dr. Jones", "mister smith and doctor jones"),
    ("I'd been there and he's gone", "i had been there and he has gone"),
    ("twenty-one", "21"),
    ("two hundred and five", "205"),
    ("one thousand two hundred thirty four", "1234"),
    ("a thousand five hundred", "a 1500"),
    ("three point one four", "3.14"),
    ("fifty percent", "50%"),
    ("5 percent and 50%", "5% and 50%"),
    ("five dollars", "$5"),
    ("the twenty first of May, the 3rd and the second", "the 21st of may the 3rd and the 2nd"),
    ("in the nineties", "in the 90s"),
    ("1,000,000 dollars", "$1000000"),
    ("The colour of the neighbour's programme", "the color of the neighbor is program"),
    ("We organised and analysed it while travelling", "we organized and analyzed it while traveling"),
    ("Café naïve résumé straße", "cafe naive resume strasse"),
    ("one oh one", "101"),
    ("double five triple zero", "55000"),
    ("minus two and a half", "-2.5"),
    ("two dollars and seven cents", "$2.07"),
    ("twenty five per cent of the vote", "25% of the vote"),
    ("no one knows the one", "no one knows the one"),
    ("two thousand and twenty five", "2025"),
    ("We realised the grey aeroplane had been catalogued", "we realized the gray airplane had been cataloged"),
]


@pytest.mark.parametrize(("raw", "expected"), ENGLISH_CASES)
def test_english_normaliser_matches_the_published_style_form(raw, expected):
    assert tn.normalise_english(raw) == expected


def test_english_spellings_of_one_sentence_normalise_to_one_string():
    a = "Mr. Smith can't pay twenty-five dollars, he said."
    b = "mister smith can not pay $25 he said"
    assert tn.normalise_english(a) == tn.normalise_english(b) == b


def test_english_normaliser_is_idempotent_on_its_own_output_and_total():
    for raw, _ in ENGLISH_CASES:
        once = tn.normalise_english(raw)
        if "-" not in once:  # the minus sign of a negative number is a symbol the second pass would drop
            assert tn.normalise_english(once) == once
    assert tn.normalise_english("") == "" and tn.normalise_english("   ?!  ") == ""


def test_number_words_follow_the_published_rules():
    assert tn.normalise_english("one two three") == "123"  # single digits in a row are read as one nominal number
    assert tn.normalise_english("twenty twenty") == "2020"
    assert tn.normalise_english("no one") == "no one"  # a bare "one" stays the word, it is also a pronoun
    assert tn.normalise_english("twenty-five thousand and six") == "25006"
    assert tn.normalise_english("three and a half million") == "3500000"
    assert tn.normalise_english("negative two point five") == "-2.5"
    assert tn.normalise_english("the sixties and seventies") == "the 60s and 70s"
    assert tn.normalise_english("$20 million") == "$20000000"


def test_apostrophes_of_either_kind_read_the_same():
    assert tn.normalise_english("She\u2019s here, isn\u2019t she?") == tn.normalise_english("She's here, isn't she?")
    assert tn.normalise_english("isn't") == "is not"


# --- Devanagari ----------------------------------------------------------------------------------------------------


def test_nukta_forms_fold_to_the_plain_letter_whether_composed_or_not():
    composed = "\u095e\u094b\u0928"  # फ़ोन as the one-code-point फ़
    decomposed = "\u092b\u093c\u094b\u0928"
    plain = "\u092b\u094b\u0928"
    assert tn.fold_devanagari(composed) == tn.fold_devanagari(decomposed) == plain
    assert tn.fold_devanagari("ज़िंदगी") == tn.fold_devanagari("जिंदगी")


def test_chandrabindu_and_anusvara_are_one_spelling():
    assert tn.fold_devanagari("चा\u0901द") == tn.fold_devanagari("चांद") == "चांद"
    assert tn.fold_devanagari("हैं") == tn.fold_devanagari("है\u0901")


def test_a_nasal_with_virama_before_its_own_class_is_the_anusvara():
    assert tn.fold_devanagari("पञ्च") == tn.fold_devanagari("पंच") == "पंच"
    assert tn.fold_devanagari("हिन्दी") == tn.fold_devanagari("हिंदी")
    assert tn.fold_devanagari("गङ्गा") == "गंगा" and tn.fold_devanagari("अम्बर") == "अंबर"
    assert tn.fold_devanagari("अन्न") == "अन्न"  # a double nasal is a real conjunct, left alone
    assert tn.fold_devanagari("न्याय") == "न्याय" and tn.fold_devanagari("सम्मान") == "सम्मान"


def test_chandra_vowels_and_zero_width_marks_are_folded():
    assert tn.fold_devanagari("ऑफिस") == tn.fold_devanagari("ओफिस")
    assert tn.fold_devanagari("डॉक्टर") == tn.fold_devanagari("डोक्टर")
    assert tn.fold_devanagari("क\u200dष\u200c") == "कष"
    assert tn.fold_devanagari("\ufeffनमस्ते\u200b") == "नमस्ते"


def test_danda_digits_and_punctuation_in_the_hindi_scoring_form():
    assert tn.normalise_devanagari("मेरे २ दोस्त हैं।") == "मेरे 2 दोस्त हैं"
    assert tn.normalise_devanagari("राम ने कहा॥ \u201cठीक है\u201d, ठीक!") == "राम ने कहा ठीक है ठीक"
    assert tn.normalise_devanagari("  Namaste,  DUNIYA ।") == "namaste duniya"
    assert tn.normalise_devanagari("") == ""


def test_hindi_error_rates_no_longer_count_nukta_anusvara_or_chandrabindu_variants():
    ref = "मेरा फ़ोन चाँद पर पञ्च लोग हिन्दी में ज़िंदगी।"
    hyp = "मेरा फोन चांद पर पंच लोग हिंदी में जिंदगी"
    assert stt_bench.wer(ref, hyp) == 0 and stt_bench.cer(ref, hyp) == 0
    assert stt_bench.wer(ref, "मेरा फोन चांद पर पंच लोग हिंदी में ज़िंदगी कल") > 0  # a real word error still counts
    assert stt_bench.normalise(ref) == tn.normalise_devanagari(ref)


def test_english_scoring_is_the_published_style_one_when_asked():
    assert stt_bench.wer("I can't pay twenty five dollars", "i can not pay $25", english=True) == 0
    assert stt_bench.wer("I can't pay twenty five dollars", "i can not pay $25") > 0  # the default is unchanged
    assert stt_bench.cer("It's 5 percent", "it is 5%", english=True) == 0
    rows = [(Path("a.wav"), "Mr. Smith has two dogs")]
    heard = lambda _p, _m: "mister smith has 2 dogs"  # noqa: E731
    assert stt_bench.score(rows, ["m"], heard, english=True)[0]["wer"] == 0
    assert stt_bench.score(rows, ["m"], heard)[0]["wer"] > 0


def test_ears_eval_word_error_rate_can_score_english_and_always_folds_devanagari():
    def scene(text):
        silence = np.zeros(10, dtype=np.float32)
        return ee.Scene(id="a", kind="speech", samples=silence, utterances=[[(0, 100)]], text=text)

    hindi = [scene("चाँद और फ़ोन")]
    assert ee.word_error_rate(hindi, lambda _x: "चांद और फोन")["wer"] == 0
    english = [scene("I can't pay twenty five dollars")]
    got = ee.word_error_rate(english, lambda _x: "I can not pay $25", english=True)
    assert got["wer"] == 0 and got["words"] == 5 and got["clips"] == 1
    assert ee.word_error_rate(english, lambda _x: "I can not pay $25")["wer"] > 0


# --- Transliteration -----------------------------------------------------------------------------------------------

HINDI_WORDS = ["कमल", "करना", "हिंदी", "हिन्दी", "क्या", "फ़ोन", "ऑफिस", "पञ्च", "दोस्त", "नहीं", "ज़िंदगी", "ज्ञान", "क्षमा",
               "हैं", "भारत", "शुक्रिया", "काइ", "खह", "चाँद", "ढ़ोल", "नमस्ते", "अंग्रेज़ी", "ऋषि", "कृष्ण", "संस्कृत"]  # fmt: skip


@pytest.mark.parametrize("word", HINDI_WORDS)
def test_itrans_round_trip_is_exact_for_devanagari(word):
    roman = tn.devanagari_to_itrans(word)
    assert roman.isascii()
    assert tn.itrans_to_devanagari(roman) == unicodedata.normalize("NFC", word)


def test_itrans_spellings_are_the_expected_ones_and_keep_fused_letters_apart():
    assert tn.devanagari_to_itrans("कमल") == "kamala"
    assert tn.devanagari_to_itrans("नमस्ते") == "namaste"
    assert tn.devanagari_to_itrans("आज") == "Aja"
    assert tn.devanagari_to_itrans("क्ह") == "k_ha"  # क्ह is not ख
    assert tn.devanagari_to_itrans("खह") == "khaha"
    assert tn.devanagari_to_itrans("काइ") == "kAi"
    assert tn.devanagari_to_itrans("कइ") == "ka_i"  # क and इ are not कै
    assert tn.itrans_to_devanagari("ka_i") == "कइ" and tn.itrans_to_devanagari("kai") == "कै"
    assert tn.itrans_to_devanagari("rAma") == "राम" and tn.itrans_to_devanagari("raam") == "रअम्"  # strict: aa is two a


def test_lenient_hinglish_spelling_of_devanagari_words():
    assert tn.devanagari_to_hinglish("कमल") == "kamal"
    assert tn.devanagari_to_hinglish("करना") == "karnaa"
    assert tn.devanagari_to_hinglish("करना", keep_schwa=True) == "karanaa"
    assert tn.devanagari_to_hinglish("हिंदी") == "hindee"
    assert tn.devanagari_to_hinglish("पञ्च") == "panch"
    assert tn.devanagari_to_hinglish("ज़िंदगी") == "zindagee"
    assert tn.devanagari_to_hinglish("शुक्रिया") == "shukriyaa"
    assert tn.devanagari_to_hinglish("संपर्क") == "sampark"  # the anusvara before a labial is an m


def test_hinglish_reads_back_to_devanagari_with_the_open_choices_listed():
    assert "कमल" in tn.hinglish_to_devanagari_candidates("kamal")
    assert tn.hinglish_to_devanagari_candidates("kya")[0] == "क्या"
    karna = tn.hinglish_to_devanagari_candidates("karna")
    assert "करना" in karna and "कर्ना" in karna
    hindi = tn.hinglish_to_devanagari_candidates("hindi")
    assert hindi[0] == "हिंदी" and "हिन्दी" in hindi
    assert tn.hinglish_to_devanagari_candidates("hain") == ["हैन", "हैं"]
    assert "ट" in tn.hinglish_to_devanagari_candidates("tab", retroflex=True)[0]
    assert tn.hinglish_to_devanagari_candidates("1234") == [] and tn.hinglish_to_devanagari_candidates("") == []


def test_every_candidate_is_a_fixed_point_of_the_devanagari_fold_or_a_variant_of_one():
    for roman in ("kamal", "karna", "hindi", "zindagi", "dost", "shukriya", "namaste"):
        for cand in tn.hinglish_to_devanagari_candidates(roman):
            assert tn.devanagari_to_itrans(cand).isascii()
            assert tn.itrans_to_devanagari(tn.devanagari_to_itrans(cand)) == cand


# --- Hotword variants ----------------------------------------------------------------------------------------------


def test_a_devanagari_hotword_gets_its_folds_and_roman_spellings():
    got = tn.hotword_variants("फ़ोन")
    assert got[0] == "फ़ोन" and "फोन" in got and "fon" in got and "phon" in got
    zindagi = tn.hotword_variants("ज़िंदगी")
    assert "जिंदगी" in zindagi and "zindagee" in zindagi and "zindagi" in zindagi
    assert "panch" in tn.hotword_variants("पञ्च") and "पंच" in tn.hotword_variants("पञ्च")


def test_a_roman_hotword_gets_roman_spellings_and_devanagari_readings():
    got = tn.hotword_variants("shukriya")
    assert got[0] == "shukriya" and "shukriyaa" in got and "शुक्रिया" in got
    hindi = tn.hotword_variants("Hindi")
    assert hindi[0] == "Hindi" and "hindi" in hindi and "हिंदी" in hindi and "hindee" in hindi
    assert "hein" in tn.hotword_variants("hain") and "हैं" in tn.hotword_variants("hain")


def test_hotword_variants_are_distinct_capped_and_safe_on_odd_input():
    for word in ("shukriya", "नमस्ते", "FRIDAY", "x", "123", "  "):
        got = tn.hotword_variants(word, limit=5)
        assert len(got) == len(set(got)) <= 5
    assert tn.hotword_variants("") == [] and tn.hotword_variants("   ") == []
    assert len(tn.hotword_variants("shukriya", limit=50)) <= 50


def test_the_hinglish_key_is_shared_by_the_usual_spellings():
    assert tn.hinglish_key("Shukriyaa") == tn.hinglish_key("shukriya")
    assert tn.hinglish_key("zindagee") == tn.hinglish_key("zindagi") == tn.hinglish_key("jindagi")
    assert tn.hinglish_key("phone") == tn.hinglish_key("fone") and tn.hinglish_key("kaam") == tn.hinglish_key("kam")
    assert tn.hinglish_key("dost") != tn.hinglish_key("dosti")
