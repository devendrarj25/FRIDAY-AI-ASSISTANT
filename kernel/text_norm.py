"""FRIDAY text normalisers for scoring and for hotword spelling variants. Standard library only.

Interface contract
------------------
* ``fold_devanagari(text)``: one Devanagari spelling per word. NFC, zero-width characters out, Devanagari digits to
  ASCII, the nukta dropped (फ़ and फ are one spelling), the chandrabindu written as the anusvara, a nasal plus virama
  before its own class written as the anusvara (पञ्च and पंच), chandra vowels written as the plain vowel (ऑफिस and
  ओफिस), the danda and double danda turned into spaces. Latin text passes through unchanged.
* ``normalise_devanagari(text)``: ``fold_devanagari``, lower case, punctuation and symbols to spaces, spaces
  collapsed. This is the scoring form for Hindi (word and character error rate).
* ``normalise_english(text)``: the published-style English form (Whisper-like basic plus English rules): brackets and
  fillers out, contractions spelled out, number words to digits (ordinals, percent, dollars, decimals), British
  spellings to American, punctuation to spaces, spaces collapsed.
* ``devanagari_to_itrans`` / ``itrans_to_devanagari``: a strict, reversible transliteration (ITRANS style, an
  ``_`` keeps two letters apart when they would read as one). ``devanagari_to_hinglish`` is the lenient Roman spelling
  people write (kamal, hindi, kyaa); ``hinglish_to_devanagari_candidates`` is its reverse with several readings.
* ``hotword_variants(word)``: the spellings a recogniser may write for one owner word, best first, at most ``limit``.
  A Devanagari word gives its own folds and Roman spellings; a Roman word gives its Roman spellings and Devanagari
  readings. ``hinglish_key(word)`` is the spelling-tolerant key two such spellings share.

Every rule has a fixture in ``kernel/tests/test_text_norm.py``.
"""

from __future__ import annotations

import itertools
import re
import unicodedata
from fractions import Fraction

# ---------------------------------------------------------------------------------------------------------------
# Devanagari
# ---------------------------------------------------------------------------------------------------------------

_ZERO_WIDTH = dict.fromkeys(map(ord, "​‌‍⁠﻿­‎‏‪‫‬"))
_DEVANAGARI_DIGITS = {ord("०") + i: str(i) for i in range(10)}
_NUKTA = "़"
_VIRAMA = "्"
_ANUSVARA = "ं"
# Chandra and short/long south vowels written as the plain Hindi vowel (ऑफिस, आफिस and ओफिस are one word).
_CHANDRA = str.maketrans(
    {"ऑ": "ओ", "ॉ": "ो", "ऍ": "ए", "ॅ": "े", "ऎ": "ए", "ॆ": "े", "ऒ": "ओ", "ॊ": "ो", "ऽ": " ", "ऀ": _ANUSVARA,
     "ँ": _ANUSVARA, "।": " ", "॥": " ", "॰": " "}
)  # fmt: skip
# The five classes of stops with their nasal: a nasal plus virama before another stop of its class is the anusvara.
_NASAL_CLASS = {
    "ङ": "कखगघ", "ञ": "चछजझ", "ण": "टठडढ", "न": "तथदध", "म": "पफबभ",
}  # fmt: skip
_NASAL_VIRAMA = re.compile("(" + "|".join(f"{n}{_VIRAMA}(?=[{stops}])" for n, stops in _NASAL_CLASS.items()) + ")")


def fold_devanagari(text: str) -> str:
    """One spelling per Devanagari word (see the module note). Case is not touched."""
    t = unicodedata.normalize("NFC", str(text)).translate(_ZERO_WIDTH).translate(_DEVANAGARI_DIGITS)
    t = t.replace(_NUKTA, "").translate(_CHANDRA)
    return _NASAL_VIRAMA.sub(_ANUSVARA, t)


def _spaced_punctuation(text: str) -> str:
    return "".join(" " if unicodedata.category(c)[0] in "PS" else c for c in text)


def normalise_devanagari(text: str) -> str:
    """The Hindi scoring form: ``fold_devanagari``, lower case, punctuation to spaces, spaces collapsed."""
    return re.sub(r"\s+", " ", _spaced_punctuation(fold_devanagari(text).lower())).strip()


# ---------------------------------------------------------------------------------------------------------------
# English (the published-style form: basic symbol and diacritic removal, contractions, number words, spellings)
# ---------------------------------------------------------------------------------------------------------------

_FILLERS = re.compile(r"\b(hmm|mm|mhm|mmm|uh|um)\b")
_APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "ʼ": "'", "`": "'", "´": "'"})
_CONTRACTIONS: tuple[tuple[str, str], ...] = (
    (r"\bwon't\b", "will not"), (r"\bcan't\b", "can not"), (r"\blet's\b", "let us"), (r"\bain't\b", "aint"),
    (r"\by'all\b", "you all"), (r"\bwanna\b", "want to"), (r"\bgotta\b", "got to"), (r"\bgonna\b", "going to"),
    (r"\bi'ma\b", "i am going to"), (r"\bimma\b", "i am going to"), (r"\bwoulda\b", "would have"),
    (r"\bcoulda\b", "could have"), (r"\bshoulda\b", "should have"), (r"\bma'am\b", "madam"),
    (r"\bmr\b", "mister "), (r"\bmrs\b", "missus "), (r"\bst\b", "saint "), (r"\bdr\b", "doctor "),
    (r"\bprof\b", "professor "), (r"\bcapt\b", "captain "), (r"\bgov\b", "governor "), (r"\bald\b", "alderman "),
    (r"\bgen\b", "general "), (r"\bsen\b", "senator "), (r"\brep\b", "representative "),
    (r"\bpres\b", "president "), (r"\brev\b", "reverend "), (r"\bhon\b", "honorable "),
    (r"\basst\b", "assistant "), (r"\bassoc\b", "associate "), (r"\blt\b", "lieutenant "),
    (r"\bcol\b", "colonel "), (r"\bjr\b", "junior "), (r"\bsr\b", "senior "), (r"\besq\b", "esquire "),
    (r"'d been\b", " had been"), (r"'s been\b", " has been"), (r"'d gone\b", " had gone"),
    (r"'s gone\b", " has gone"), (r"'d done\b", " had done"), (r"'s got\b", " has got"),
    (r"n't\b", " not"), (r"'re\b", " are"), (r"'s\b", " is"), (r"'d\b", " would"), (r"'ll\b", " will"),
    (r"'t\b", " not"), (r"'ve\b", " have"), (r"'m\b", " am"),
)  # fmt: skip
_COMPILED_CONTRACTIONS = tuple((re.compile(p), r) for p, r in _CONTRACTIONS)
_KEEP_SYMBOLS = ".%$¢€£"
# Letters that NFKD does not split into a base letter and a mark.
_EXTRA_DIACRITICS = {
    "œ": "oe", "Œ": "OE", "ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "ß": "ss", "ẞ": "SS", "đ": "d", "Đ": "D",
    "ð": "d", "Ð": "D", "þ": "th", "Þ": "th", "ł": "l", "Ł": "L",
}  # fmt: skip


def _strip_symbols(text: str, keep: str = "") -> str:
    """Accents removed, every other mark, symbol and punctuation character a space (the characters in ``keep`` stay)."""
    out = []
    for c in unicodedata.normalize("NFKD", text):
        if c in keep:
            out.append(c)
        elif c in _EXTRA_DIACRITICS:
            out.append(_EXTRA_DIACRITICS[c])
        elif unicodedata.category(c) == "Mn":
            continue
        else:
            out.append(" " if unicodedata.category(c)[0] in "MSP" else c)
    return "".join(out)


class _NumberWords:
    """Spelled-out numbers to digits: ``twenty one`` is 21, ``two thousand and five`` 2005, ``one oh one`` 101,
    ``double five`` 55, ``three point one four`` 3.14, ``fifty percent`` 50%, ``five dollars`` $5, ``twenty first``
    21st, ``the nineties`` the 90s, ``minus two`` -2. A bare ``one`` stays the word (it is also a pronoun)."""

    def __init__(self) -> None:
        self.zeros = {"o", "oh", "zero"}
        names = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen"
        self.ones = {name: i for i, name in enumerate((names + " seventeen eighteen nineteen").split(), start=1)}
        self.ones_suffixed = {
            **{("sixes" if n == "six" else n + "s"): (v, "s") for n, v in self.ones.items()},
            "zeroth": (0, "th"), "first": (1, "st"), "second": (2, "nd"), "third": (3, "rd"), "fifth": (5, "th"),
            "twelfth": (12, "th"),
            **{
                n + ("h" if n.endswith("t") else "th"): (v, "th")
                for n, v in self.ones.items()
                if v > 3 and v not in (5, 12)
            },
        }  # fmt: skip
        tens_names = "twenty thirty forty fifty sixty seventy eighty ninety".split()
        self.tens = {w: 20 + 10 * i for i, w in enumerate(tens_names)}
        self.tens_suffixed = {
            **{n.replace("y", "ies"): (v, "s") for n, v in self.tens.items()},
            **{n.replace("y", "ieth"): (v, "th") for n, v in self.tens.items()},
        }
        scales = "hundred thousand million billion trillion quadrillion quintillion sextillion septillion octillion"
        self.multipliers = {"hundred": 100}
        for i, name in enumerate(scales.split()[1:] + ["nonillion", "decillion"], start=1):
            self.multipliers[name] = 1000**i
        self.multipliers_suffixed = {
            **{n + "s": (v, "s") for n, v in self.multipliers.items()},
            **{n + "th": (v, "th") for n, v in self.multipliers.items()},
        }
        self.decimals = {*self.ones, *self.tens, *self.zeros}
        self.preceding_prefixers = {"minus": "-", "negative": "-", "plus": "+", "positive": "+"}
        self.following_prefixers = {
            "pound": "£", "pounds": "£", "euro": "€", "euros": "€", "dollar": "$", "dollars": "$", "cent": "¢",
            "cents": "¢",
        }  # fmt: skip
        self.prefixes = {*self.preceding_prefixers.values(), *self.following_prefixers.values()}
        self.suffixers: dict[str, str | dict[str, str]] = {"per": {"cent": "%"}, "percent": "%"}
        self.specials = {"and", "double", "triple", "point"}
        self.words = {
            *self.zeros, *self.ones, *self.ones_suffixed, *self.tens, *self.tens_suffixed, *self.multipliers,
            *self.multipliers_suffixed, *self.preceding_prefixers, *self.following_prefixers, *self.suffixers,
            *self.specials,
        }  # fmt: skip

    def process_words(self, words: list[str]) -> list[str]:  # noqa: C901 — one state machine over the words
        out: list[str] = []
        prefix: str | None = None
        value: str | int | None = None
        skip = False

        def to_fraction(s: str | int) -> Fraction | None:
            try:
                return Fraction(s)
            except ValueError:
                return None

        def emit(result: str | int) -> None:
            nonlocal prefix, value
            out.append((prefix or "") + str(result))
            value = None
            prefix = None

        padded: list[str | None] = [None, *words, None]
        for i in range(len(words)):
            prev, current, nxt = padded[i], padded[i + 1] or "", padded[i + 2]
            if skip:
                skip = False
                continue
            next_is_numeric = nxt is not None and re.fullmatch(r"\d+(\.\d+)?", nxt) is not None
            has_prefix = current[0] in self.prefixes
            bare = current[1:] if has_prefix else current
            if re.fullmatch(r"\d+(\.\d+)?", bare):
                f = to_fraction(bare)
                if f is None:
                    continue
                if value is not None:
                    if isinstance(value, str) and value.endswith("."):
                        value = value + current  # decimals and address parts: 3 . 14
                        continue
                    emit(value)
                prefix = current[0] if has_prefix else prefix
                value = f.numerator if f.denominator == 1 else bare
            elif current not in self.words:
                if value is not None:
                    emit(value)
                emit(current)
            elif current in self.zeros:
                value = str(value or "") + "0"
            elif current in self.ones:
                ones = self.ones[current]
                if value is None:
                    value = ones
                elif isinstance(value, str) or prev in self.ones:
                    if prev in self.tens and ones < 10 and str(value)[-1] == "0":
                        value = str(value)[:-1] + str(ones)  # twenty one: the zero of twenty becomes the digit
                    else:
                        value = str(value) + str(ones)
                elif ones < 10:
                    value = value + ones if value % 10 == 0 else str(value) + str(ones)
                else:  # eleven to nineteen
                    value = value + ones if value % 100 == 0 else str(value) + str(ones)
            elif current in self.ones_suffixed:
                ones, suffix = self.ones_suffixed[current]
                if value is None:
                    emit(str(ones) + suffix)
                elif isinstance(value, str) or prev in self.ones:
                    if prev in self.tens and ones < 10 and str(value)[-1] == "0":
                        emit(str(value)[:-1] + str(ones) + suffix)
                    else:
                        emit(str(value) + str(ones) + suffix)
                elif ones < 10:
                    emit((str(value + ones) if value % 10 == 0 else str(value) + str(ones)) + suffix)
                else:
                    emit((str(value + ones) if value % 100 == 0 else str(value) + str(ones)) + suffix)
                value = None
            elif current in self.tens:
                tens = self.tens[current]
                if value is None:
                    value = tens
                elif isinstance(value, str):
                    value = value + str(tens)
                else:
                    value = value + tens if value % 100 == 0 else str(value) + str(tens)
            elif current in self.tens_suffixed:
                tens, suffix = self.tens_suffixed[current]
                if value is None:
                    emit(str(tens) + suffix)
                elif isinstance(value, str):
                    emit(value + str(tens) + suffix)
                else:
                    emit((str(value + tens) if value % 100 == 0 else str(value) + str(tens)) + suffix)
            elif current in self.multipliers:
                multiplier = self.multipliers[current]
                if value is None:
                    value = multiplier
                elif isinstance(value, str) or value == 0:
                    f = to_fraction(value)
                    product = f * multiplier if f is not None else None
                    if product is not None and product.denominator == 1:
                        value = product.numerator
                    else:
                        emit(value)
                        value = multiplier
                else:
                    value = value // 1000 * 1000 + (value % 1000) * multiplier
            elif current in self.multipliers_suffixed:
                multiplier, suffix = self.multipliers_suffixed[current]
                if value is None:
                    emit(str(multiplier) + suffix)
                elif isinstance(value, str):
                    f = to_fraction(value)
                    product = f * multiplier if f is not None else None
                    if product is not None and product.denominator == 1:
                        emit(str(product.numerator) + suffix)
                    else:
                        emit(value)
                        emit(str(multiplier) + suffix)
                else:
                    emit(str(value // 1000 * 1000 + (value % 1000) * multiplier) + suffix)
                value = None
            elif current in self.preceding_prefixers:
                if value is not None:
                    emit(value)
                if (nxt in self.words) or next_is_numeric:
                    prefix = self.preceding_prefixers[current]
                else:
                    emit(current)
            elif current in self.following_prefixers:
                if value is not None:
                    prefix = self.following_prefixers[current]
                    emit(value)
                else:
                    emit(current)
            elif current in self.suffixers:
                if value is None:
                    emit(current)
                else:
                    suffix = self.suffixers[current]
                    if isinstance(suffix, dict):
                        if nxt in suffix:
                            emit(str(value) + suffix[nxt])
                            skip = True
                        else:
                            emit(value)
                            emit(current)
                    else:
                        emit(str(value) + suffix)
            elif current in self.specials:
                if nxt not in self.words and not next_is_numeric:
                    if value is not None:
                        emit(value)
                    emit(current)
                elif current == "and":
                    if prev not in self.multipliers:  # "and" after hundreds or thousands is dropped
                        if value is not None:
                            emit(value)
                        emit(current)
                elif current in ("double", "triple"):
                    if nxt in self.ones or nxt in self.zeros:
                        value = str(value or "") + str(self.ones.get(nxt or "", 0)) * (2 if current == "double" else 3)
                        skip = True
                    else:
                        if value is not None:
                            emit(value)
                        emit(current)
                elif current == "point" and (nxt in self.decimals or next_is_numeric):
                    value = str(value or "") + "."
        if value is not None:
            emit(value)
        return out

    def preprocess(self, text: str) -> str:
        # "<number> and a half" is "<number> point five"
        results: list[str] = []
        segments = re.split(r"\band\s+a\s+half\b", text)
        for i, segment in enumerate(segments):
            if not segment.strip():
                continue
            results.append(segment)
            if i != len(segments) - 1:
                last = segment.rsplit(maxsplit=2)[-1]
                results.append("point five" if last in self.decimals or last in self.multipliers else "and a half")
        text = " ".join(results)
        text = re.sub(r"([a-z])([0-9])", r"\1 \2", text)  # a space at a number/letter boundary
        text = re.sub(r"([0-9])([a-z])", r"\1 \2", text)
        return re.sub(r"([0-9])\s+(st|nd|rd|th|s)\b", r"\1\2", text)  # but not where it is a suffix

    @staticmethod
    def postprocess(text: str) -> str:
        def combine_cents(m: re.Match[str]) -> str:
            return f"{m.group(1)}{m.group(2)}.{int(m.group(3)):02d}"

        text = re.sub(r"([€£$])([0-9]+) (?:and )?¢([0-9]{1,2})\b", combine_cents, text)  # "$2 and ¢7" is "$2.07"
        text = re.sub(r"[€£$]0.([0-9]{1,2})\b", lambda m: f"¢{int(m.group(1))}", text)
        return re.sub(r"(?<!\S)1(s?)(?!\S)", r"one\1", text)  # a bare 1 reads as the word

    def __call__(self, text: str) -> str:
        return self.postprocess(" ".join(self.process_words(self.preprocess(text).split())))


_NUMBERS = _NumberWords()

# British to American spelling. Three families are written as stems (every ending of a stem is mapped), the rest as
# plain pairs.
_ISE_ENDINGS = ("ation", "ations", "e", "ed", "es", "ing", "er", "ers", "able")
_YSE_ENDINGS = ("e", "ed", "es", "ing", "er", "ers", "able")
_OUR_ENDINGS = ("", "s", "ed", "ing", "ful", "less", "ite", "able", "ly", "y", "ist", "ists", "ers", "er", "ies")
_ISE_STEMS = (
    "accessor acclimat agon amort anglic annual antagon apolog appet author bapt bastard bowdler brutal canal "
    "cannibal canon capital caramel carbon categor cauter central character circular civil collectiv colon "
    "commercial compartmental computer conceptual contextual criminal critic crystall custom decentral decriminal "
    "dehuman demilitar demobil democrat demon demoral denational deodor depersonal deput desensit destabil digit "
    "disorgan dramat econom editorial empath emphas energ epitom equal eulog evangel exorc extempor external "
    "factor familiar fantas femin fertil fictional final formal fossil fratern galvan general ghetto glamor "
    "global harmon homogen hospital human hybrid hypnot hypothes ideal idol immobil immortal immun individual "
    "industrial initial institutional intellectual internal international ion italic item jeopard legal legitim "
    "liberal lion liquid local magnet marginal material maxim mechan memor memorial mesmer metabol militar "
    "miniatur minim mobil modern moistur monopol moral motor national natural neutral normal optim organ ostrac "
    "overemphas oxid particular passiv pasteur patron pedestrian penal personal philosoph plagiar polar politic "
    "popular pressur priorit privat professional propagand proselyt public pulver radical random rational real "
    "recogn regular reorgan revital revolution rhapsod ritual romantic sanit satir scandal scrutin secular "
    "sensational sensit sentimental serial sermon signal social sodom solemn special stabil standard steril "
    "stigmat subsid summar symbol sympath synchron synthes systemat tantal tempor tender terror theor transistor "
    "traumat trivial tyrann unauthor uncivil underutil union unorgan unrecogn urban util vandal vapor verbal "
    "victim visual vocal vulcan vulgar western woman"
)
_YSE_STEMS = "anal breathal catal paral psychoanal"
_OUR_STEMS = (
    "arb ard arm behavi belab cand clam clang col demean discol disfav dishon enam endeav fav ferv flav harb hon "
    "hum lab misbehavi misdemean multicol neighb parl ranc rig rum sav savi splend succ technicol tricol tum "
    "unfav unsav val vap vig watercol"
)
_SPELLING_PAIRS = (
    "accoutrements accouterments aeon eon aeons eons aerogramme aerogram aerogrammes aerograms aeroplane airplane "
    "aeroplanes airplanes aesthete esthete aesthetes esthetes aesthetic esthetic aesthetically esthetically "
    "aesthetics esthetics aetiology etiology ageing aging aggrandisement aggrandizement agonisingly agonizingly "
    "almanack almanac almanacks almanacs aluminium aluminum amphitheatre amphitheater amphitheatres amphitheaters "
    "anaemia anemia anaemic anemic anaesthesia anesthesia anaesthetic anesthetic anaesthetics anesthetics "
    "anaesthetise anesthetize anaesthetised anesthetized anaesthetises anesthetizes anaesthetising anesthetizing "
    "anaesthetist anesthetist anaesthetists anesthetists anaesthetize anesthetize anaesthetized anesthetized "
    "anaesthetizes anesthetizes anaesthetizing anesthetizing analogue analog analogues analogs appal appall "
    "appals appalls appetisingly appetizingly archeological archaeological archaeologically archeologically "
    "archaeologist archeologist archaeologists archeologists artefact artifact artefacts artifacts axe ax "
    "backpedalled backpedaled backpedalling backpedaling bannister banister bannisters banisters battleax "
    "battleaxe baulk balk baulked balked baulking balking baulks balks bedevilled bedeviled bedevilling "
    "bedeviling behavioural behavioral behaviourism behaviorism behove behoove behoved behooved behoves behooves "
    "bejewelled bejeweled bevelled beveled bevvies bevies bevvy bevy biassed biased biassing biasing bingeing "
    "binging bougainvillaea bougainvillea bougainvillaeas bougainvilleas busses buses bussing busing caesarean "
    "cesarean caesareans cesareans calibre caliber calibres calibers calliper caliper callipers calipers "
    "callisthenics calisthenics cancelation cancellation cancelations cancellations cancelled canceled cancelling "
    "canceling carolled caroled carolling caroling catalogue catalog catalogued cataloged catalogues catalogs "
    "cataloguing cataloging cavilled caviled cavilling caviling centigramme centigram centigrammes centigrams "
    "centilitre centiliter centilitres centiliters centimetre centimeter centimetres centimeters centre center "
    "centred centered centrefold centerfold centrefolds centerfolds centrepiece centerpiece centrepieces "
    "centerpieces centres centers channelled channeled channelling channeling cheque check chequebook checkbook "
    "chequebooks checkbooks chequered checkered cheques checks chilli chili chimaera chimera chimaeras chimeras "
    "chiselled chiseled chiselling chiseling clarinettist clarinetist clarinettists clarinetists colourant "
    "colorant colourants colorants coloureds coloreds colourfully colorfully colourize colorize colourized "
    "colorized colourizes colorizes colourizing colorizing connexion connection connexions connections cosier "
    "cozier cosies cozies cosiest coziest cosily cozily cosiness coziness cosy cozy councillor councilor "
    "councillors councilors counselled counseled counselling counseling counsellor counselor counsellors "
    "counselors crenelated crenellated crueller crueler cruellest cruelest cudgelled cudgeled cudgelling "
    "cudgeling cypher cipher cyphers ciphers defence defense defenceless defenseless defences defenses dialled "
    "dialed dialling dialing dialogue dialog dialogues dialogs diarrhoea diarrhea disc disk discs disks "
    "disembowelled disemboweled disembowelling disemboweling dishevelled disheveled dishonourably dishonorably "
    "distil distill distils distills draught draft draughtboard draftboard draughtboards draftboards draughtier "
    "draftier draughtiest draftiest draughts drafts draughtsman draftsman draughtsmanship draftsmanship "
    "draughtsmen draftsmen draughtswoman draftswoman draughtswomen draftswomen draughty drafty drivelled driveled "
    "drivelling driveling duelled dueled duelling dueling edoema edema enamelled enameled enamelling enameling "
    "encyclopaedia encyclopedia encyclopaedias encyclopedias encyclopaedic encyclopedic enrol enroll enrols "
    "enrolls enthral enthrall enthrals enthralls epaulette epaulet epaulettes epaulets epicentre epicenter "
    "epicentres epicenters epilogue epilog epilogues epilogs faecal fecal faeces feces favourably favorably "
    "favourites favorites favouritism favoritism fibre fiber fibreglass fiberglass fibres fibers fillet filet "
    "filleted fileted filleting fileting fillets filets flautist flutist flautists flutists flavourings "
    "flavorings flavoursome flavorsome foetal fetal foetid fetid foetus fetus foetuses fetuses fulfil fulfill "
    "fulfilment fulfillment fulfils fulfills funnelled funneled funnelling funneling gambolled gamboled "
    "gambolling gamboling gaol jail gaolbird jailbird gaolbirds jailbirds gaolbreak jailbreak gaolbreaks "
    "jailbreaks gaoled jailed gaoler jailer gaolers jailers gaoling jailing gaols jails gasses gases gage gauge "
    "gaged gauged gages gauges gaging gauging gipsies gypsies glamor glamour glueing gluing goitre goiter goitres "
    "goiters gonorrhoea gonorrhea gramme gram grammes grams gravelled graveled grey gray greyed grayed greying "
    "graying greyish grayish greyness grayness greys grays grovelled groveled grovelling groveling groyne groin "
    "groynes groins gruelling grueling gruellingly gruelingly gryphon griffin gryphons griffins gynaecological "
    "gynecological gynaecologist gynecologist gynaecologists gynecologists gynaecology gynecology haematological "
    "hematological haematologist hematologist haematologists hematologists haematology hematology haemoglobin "
    "hemoglobin haemophilia hemophilia haemophiliac hemophiliac haemophiliacs hemophiliacs haemorrhage hemorrhage "
    "haemorrhaged hemorrhaged haemorrhages hemorrhages haemorrhaging hemorrhaging haemorrhoids hemorrhoids "
    "homoeopath homeopath homoeopathic homeopathic homoeopaths homeopaths homoeopathy homeopathy honourably "
    "honorably impanelled impaneled impanelling impaneling imperilled imperiled imperilling imperiling inflexion "
    "inflection inflexions inflections initialled initialed initialling initialing instal install instalment "
    "installment instalments installments instals installs instil instill instils instills jewelled jeweled "
    "jeweller jeweler jewellers jewelers jewellery jewelry judgement judgment kilogramme kilogram kilogrammes "
    "kilograms kilometre kilometer kilometres kilometers labelled labeled labelling labeling lacklustre "
    "lackluster leukaemia leukemia levelled leveled leveller leveler levellers levelers levelling leveling "
    "libelled libeled libelling libeling libellous libelous licence license licenced licensed licences licenses "
    "licencing licensing likeable likable litre liter litres liters louvre louver louvred louvered louvres "
    "louvers lustre luster manoeuvrability maneuverability manoeuvrable maneuverable manoeuvre maneuver "
    "manoeuvred maneuvered manoeuvres maneuvers manoeuvring maneuvering manoeuvrings maneuverings marshalled "
    "marshaled marshalling marshaling marvelled marveled marvelling marveling marvellous marvelous marvellously "
    "marvelously meagre meager mediaeval medieval metre meter metres meters micrometre micrometer micrometres "
    "micrometers milligramme milligram milligrammes milligrams millilitre milliliter millilitres milliliters "
    "millimetre millimeter millimetres millimeters minibusses minibuses misspelt misspelled mitre miter mitres "
    "miters modelled modeled modeller modeler modellers modelers modelling modeling monologue monolog monologues "
    "monologs mould mold moulded molded moulder molder mouldered moldered mouldering moldering moulders molders "
    "mouldier moldier mouldiest moldiest moulding molding mouldings moldings moulds molds mouldy moldy moult molt "
    "moulted molted moulting molting moults molts moustache mustache moustached mustached moustaches mustaches "
    "moustachioed mustachioed neighbourhood neighborhood neighbourhoods neighborhoods neighbourliness "
    "neighborliness odour odor odourless odorless odours odors oesophagus esophagus oesophaguses esophaguses "
    "oestrogen estrogen offence offense offences offenses omelette omelet omelettes omelets organisational "
    "organizational orthopaedic orthopedic orthopaedics orthopedics outmanoeuvre outmaneuver outmanoeuvred "
    "outmaneuvered outmanoeuvres outmaneuvers outmanoeuvring outmaneuvering paederast pederast paederasts "
    "pederasts paediatric pediatric paediatrician pediatrician paediatricians pediatricians paediatrics "
    "pediatrics paedophile pedophile paedophiles pedophiles paedophilia pedophilia palaeolithic paleolithic "
    "palaeontologist paleontologist palaeontologists paleontologists palaeontology paleontology panelled paneled "
    "panelling paneling panellist panelist panellists panelists parcelled parceled parcelling parceling "
    "patronisingly patronizingly pedalled pedaled pedalling pedaling pencilled penciled pencilling penciling "
    "pharmacopoeia pharmacopeia pharmacopoeias pharmacopeias philtre filter philtres filters phoney phony plough "
    "plow ploughed plowed ploughing plowing ploughman plowman ploughmen plowmen ploughs plows ploughshare "
    "plowshare ploughshares plowshares pouffe pouf pouffes poufs practise practice practised practiced practises "
    "practices practising practicing praesidium presidium praesidiums presidiums pretence pretense pretences "
    "pretenses primaeval primeval programme program programmes programs prologue prolog prologues prologs "
    "pummelled pummel pummelling pummeled pyjama pajama pyjamas pajamas pzazz pizzazz quarrelled quarreled "
    "quarrelling quarreling ravelled raveled ravelling raveling recognisably recognizably recognisance "
    "recognizance reconnoitre reconnoiter reconnoitred reconnoitered reconnoitres reconnoiters reconnoitring "
    "reconnoitering refuelled refueled refuelling refueling remodelled remodeled remodelling remodeling remould "
    "remold remoulded remolded remoulding remolding remoulds remolds revelled reveled reveller reveler revellers "
    "revelers revelling reveling rivalled rivaled rivalling rivaling sabre saber sabres sabers saltpetre "
    "saltpeter sceptic skeptic sceptical skeptical sceptically skeptically scepticism skepticism sceptics "
    "skeptics sceptre scepter sceptres scepters sepulchre sepulcher sepulchres sepulchers sheikh sheik shovelled "
    "shoveled shovelling shoveling shrivelled shriveled shrivelling shriveling signalled signaled signalling "
    "signaling smoulder smolder smouldered smoldered smouldering smoldering smoulders smolders snivelled sniveled "
    "snivelling sniveling snorkelled snorkeled snorkelling snorkeling snowplough snowplow snowploughs snowplow "
    "sombre somber spectre specter spectres specters spiralled spiraled spiralling spiraling squirrelled "
    "squirreled squirrelling squirreling stencilled stenciled stencilling stenciling storey story storeys stories "
    "sulphate sulfate sulphates sulfates sulphide sulfide sulphides sulfides sulphur sulfur sulphurous sulfurous "
    "swivelled swiveled swivelling swiveling syphon siphon syphoned siphoned syphoning siphoning syphons siphons "
    "tantalisingly tantalizingly tasselled tasseled theatre theater theatregoer theatergoer theatregoers "
    "theatergoers theatres theaters tonne ton tonnes tons towelled toweled towelling toweling toxaemia toxemia "
    "tranquillise tranquilize tranquillised tranquilized tranquilliser tranquilizer tranquillisers tranquilizers "
    "tranquillises tranquilizes tranquillising tranquilizing tranquillity tranquility tranquillize tranquilize "
    "tranquillized tranquilized tranquillizer tranquilizer tranquillizers tranquilizers tranquillizes "
    "tranquilizes tranquillizing tranquilizing tranquilly tranquility travelled traveled traveller traveler "
    "travellers travelers travelling traveling travelog travelogue travelogs travelogues trialled trialed "
    "trialling trialing tunnelled tunneled tunnelling tunneling tyre tire tyres tires unequalled unequaled "
    "unfavourably unfavorably unravelled unraveled unravelling unraveling unrivalled unrivaled untrammelled "
    "untrammeled videodisc videodisk videodiscs videodisks waggon wagon waggons wagons weaselled weaseled "
    "weaselling weaseling woollen woolen woollens woolens woollies woolies woolly wooly worshipped worshiped "
    "worshipping worshiping worshipper worshiper yodelled yodeled yodelling yodeling yoghourt yogurt yoghourts "
    "yogurts yoghurt yogurt yoghurts yogurts mhm hmm mmm hmm"
)


def _spelling_table() -> dict[str, str]:
    table = dict(zip(*[iter(_SPELLING_PAIRS.split())] * 2, strict=True))
    for stems, old, new, endings in (
        (_ISE_STEMS, "is", "iz", _ISE_ENDINGS), (_YSE_STEMS, "ys", "yz", _YSE_ENDINGS),
        (_OUR_STEMS, "our", "or", _OUR_ENDINGS),
    ):  # fmt: skip
        for stem in stems.split():
            for ending in endings:
                table[stem + old + ending] = stem + new + ending
    return table


_AMERICAN = _spelling_table()


def normalise_english(text: str) -> str:
    """The English scoring form (see the module note)."""
    s = str(text).lower().translate(_APOSTROPHES)
    s = re.sub(r"[<\[][^>\]]*[>\]]", "", s)  # words between brackets
    s = re.sub(r"\(([^)]+?)\)", "", s)  # words between parentheses
    s = _FILLERS.sub("", s)
    s = re.sub(r"\s+'", "'", s)
    for pattern, repl in _COMPILED_CONTRACTIONS:
        s = pattern.sub(repl, s)
    s = re.sub(r"(\d),(\d)", r"\1\2", s)  # commas between digits
    s = re.sub(r"\.([^0-9]|$)", r" \1", s)  # periods not followed by a digit
    s = _strip_symbols(s, keep=_KEEP_SYMBOLS)
    s = _NUMBERS(s)
    s = " ".join(_AMERICAN.get(w, w) for w in s.split())
    s = re.sub(r"[.$¢€£]([^0-9])", r" \1", s)  # a money or decimal sign that no number follows
    s = re.sub(r"([^0-9])%", r"\1 ", s)
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------------------------------------------------------
# Transliteration
# ---------------------------------------------------------------------------------------------------------------

# Strict ITRANS-style tables. Nukta letters use the usual single signs (q K G z f, .D .Dh).
_ITRANS_VOWELS = {
    "अ": "a", "आ": "A", "इ": "i", "ई": "I", "उ": "u", "ऊ": "U", "ऋ": "RRi", "ए": "e", "ऐ": "ai", "ओ": "o",
    "औ": "au", "ऑ": "O", "ऍ": "E",
}  # fmt: skip
_ITRANS_MATRAS = {
    "ा": "A", "ि": "i", "ी": "I", "ु": "u", "ू": "U", "ृ": "RRi", "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
    "ॉ": "O", "ॅ": "E",
}  # fmt: skip
_ITRANS_CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "~N", "च": "ch", "छ": "Ch", "ज": "j", "झ": "jh", "ञ": "~n",
    "ट": "T", "ठ": "Th", "ड": "D", "ढ": "Dh", "ण": "N", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "ळ": "L", "व": "v",
    "श": "sh", "ष": "Sh", "स": "s", "ह": "h",
}  # fmt: skip
_ITRANS_NUKTA = {"क": "q", "ख": "K", "ग": "G", "ज": "z", "ड": ".D", "ढ": ".Dh", "फ": "f"}
_ITRANS_CONSONANTS.update({base + "\u093c": roman for base, roman in _ITRANS_NUKTA.items()})
_ITRANS_SIGNS = {"ं": "M", "ँ": ".N", "ः": "H", "ऽ": ".a"}
_FROM_ITRANS_VOWELS = {v: k for k, v in _ITRANS_VOWELS.items()}
_FROM_ITRANS_MATRAS = {v: k for k, v in _ITRANS_MATRAS.items()}
_FROM_ITRANS_CONSONANTS = {v: k for k, v in _ITRANS_CONSONANTS.items()}
_FROM_ITRANS_SIGNS = {v: k for k, v in _ITRANS_SIGNS.items()}
_ITRANS_TOKENS = sorted(
    {*_FROM_ITRANS_VOWELS, *_FROM_ITRANS_CONSONANTS, *_FROM_ITRANS_SIGNS}, key=lambda t: (-len(t), t)
)


def _devanagari_units(word: str) -> list[tuple[str, str]]:
    """The word as ``(kind, text)`` units: V vowel, C consonant (with its nukta), M matra, X virama, S sign, O other."""
    t = unicodedata.normalize("NFC", word)
    units: list[tuple[str, str]] = []
    i = 0
    while i < len(t):
        c = t[i]
        if c in _ITRANS_CONSONANTS:
            if t[i + 1 : i + 2] == _NUKTA and c + _NUKTA in _ITRANS_CONSONANTS:
                c, i = c + _NUKTA, i + 1
            units.append(("C", c))
        elif c in _ITRANS_VOWELS:
            units.append(("V", c))
        elif c in _ITRANS_MATRAS:
            units.append(("M", c))
        elif c == _VIRAMA:
            units.append(("X", c))
        elif c in _ITRANS_SIGNS:
            units.append(("S", c))
        else:
            units.append(("O", c))
        i += 1
    return units


def _join_itrans(tokens: list[str]) -> str:
    """Join tokens, putting ``_`` where the next token would otherwise fuse with the end of the last one."""
    out = ""
    last = ""
    for tok in tokens:
        if last and tok:
            fused = last + tok
            if any(t != last and t.startswith(last) and fused.startswith(t) for t in _ITRANS_TOKENS):
                out += "_"
        out += tok
        last = tok
    return out


def devanagari_to_itrans(text: str) -> str:
    """Strict, reversible Roman spelling of Devanagari text (the inherent "a" is always written)."""
    tokens: list[str] = []
    units = _devanagari_units(str(text))
    for idx, (kind, ch) in enumerate(units):
        nxt = units[idx + 1][0] if idx + 1 < len(units) else ""
        if kind == "C":
            tokens.append(_ITRANS_CONSONANTS[ch])
            if nxt not in ("M", "X"):
                tokens.append("a")
        elif kind == "V":
            tokens.append(_ITRANS_VOWELS[ch])
        elif kind == "M":
            tokens.append(_ITRANS_MATRAS[ch])
        elif kind == "S":
            tokens.append(_ITRANS_SIGNS[ch])
        elif kind == "O":
            tokens.append(ch)
    return _join_itrans(tokens)


def itrans_to_devanagari(text: str) -> str:
    """The reverse of ``devanagari_to_itrans`` (greedy longest token; ``_`` only separates)."""
    s = str(text)
    out: list[str] = []
    pending_consonant = False  # the last output is a consonant that has not yet got a vowel or virama
    i = 0
    while i < len(s):
        tok = next((t for t in _ITRANS_TOKENS if s.startswith(t, i)), None)
        if tok is None:
            if pending_consonant:
                out.append(_VIRAMA)
                pending_consonant = False
            if s[i] != "_":
                out.append(s[i])
            i += 1
            continue
        i += len(tok)
        if tok in _FROM_ITRANS_CONSONANTS:
            if pending_consonant:
                out.append(_VIRAMA)
            out.append(_FROM_ITRANS_CONSONANTS[tok])
            pending_consonant = True
        elif tok in _FROM_ITRANS_VOWELS:
            if pending_consonant:
                if tok != "a":
                    out.append(_FROM_ITRANS_MATRAS.get(tok, _FROM_ITRANS_VOWELS[tok]))
                pending_consonant = False
            else:
                out.append(_FROM_ITRANS_VOWELS[tok])
        else:
            if pending_consonant:
                out.append(_VIRAMA)
                pending_consonant = False
            out.append(_FROM_ITRANS_SIGNS[tok])
    if pending_consonant:
        out.append(_VIRAMA)
    return unicodedata.normalize("NFC", "".join(out))


# Lenient Roman spellings (what a Hindi speaker types). Retroflex and dental letters share a spelling.
_HINGLISH_VOWELS = {
    "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o",
    "औ": "au", "ऑ": "o", "ऍ": "e",
}  # fmt: skip
_HINGLISH_MATRAS = {
    "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
    "ॉ": "o", "ॅ": "e",
}  # fmt: skip
_HINGLISH_CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "ळ": "l", "व": "v",
    "श": "sh", "ष": "sh", "स": "s", "ह": "h",
}  # fmt: skip
_HINGLISH_NUKTA = {"क": "q", "ख": "kh", "ग": "g", "ज": "z", "ड": "r", "ढ": "rh", "फ": "f"}
_HINGLISH_CONSONANTS.update({base + "\u093c": roman for base, roman in _HINGLISH_NUKTA.items()})
_LABIALS = set("पफबभम")


def devanagari_to_hinglish(word: str, *, keep_schwa: bool = False) -> str:
    """The lenient Roman spelling of one Devanagari word. The inherent "a" is dropped at the end of the word and
    between two syllables (karna); ``keep_schwa=True`` writes it everywhere it is pronounced in careful speech."""
    units = _devanagari_units(_NASAL_VIRAMA.sub(_ANUSVARA, unicodedata.normalize("NFC", word)))
    out: list[str] = []
    for idx, (kind, ch) in enumerate(units):
        nxt = units[idx + 1][0] if idx + 1 < len(units) else ""
        if kind == "C":
            out.append(_HINGLISH_CONSONANTS[ch])
            if nxt in ("M", "X"):
                continue
            tail = [u for u in units[idx + 1 :] if u[0] != "S"]
            open_before = idx > 0 and units[idx - 1][0] in ("C", "M", "V")
            medial = open_before and len(tail) >= 2 and tail[0][0] == "C" and tail[1][0] in ("M", "V")
            if tail and not (medial and not keep_schwa):
                out.append("a")
        elif kind == "V":
            out.append(_HINGLISH_VOWELS[ch])
        elif kind == "M":
            out.append(_HINGLISH_MATRAS[ch])
        elif kind == "S":
            labial_next = idx + 1 < len(units) and units[idx + 1][1] in _LABIALS
            out.append("" if ch == "ऽ" else "h" if ch == "ः" else "m" if ch == "ं" and labial_next else "n")
        elif kind == "O":
            out.append(ch)
    return "".join(out)


_ROMAN_TOKENS = sorted(
    ["chh", "ksh", "kh", "gh", "ch", "jh", "th", "dh", "ph", "bh", "sh", "aa", "ee", "ii", "oo", "uu", "ai", "au",
     "ei", "ou", "ae"],
    key=lambda t: (-len(t), t),
)  # fmt: skip
_ROMAN_CONSONANTS = {
    "k": "क", "kh": "ख", "g": "ग", "gh": "घ", "c": "क", "ch": "च", "chh": "छ", "j": "ज", "jh": "झ", "q": "क़",
    "t": "त", "th": "थ", "d": "द", "dh": "ध", "n": "न", "p": "प", "ph": "फ", "f": "फ़", "b": "ब", "bh": "भ",
    "m": "म", "y": "य", "r": "र", "l": "ल", "v": "व", "w": "व", "sh": "श", "s": "स", "h": "ह", "z": "ज़",
    "x": "क्स", "ksh": "क्ष",
}  # fmt: skip
_RETROFLEX = {"त": "ट", "थ": "ठ", "द": "ड", "ध": "ढ", "न": "ण"}
_ROMAN_VOWELS = {
    "a": ("अ", ""), "aa": ("आ", "ा"), "i": ("इ", "ि"), "ee": ("ई", "ी"), "ii": ("ई", "ी"), "u": ("उ", "ु"),
    "oo": ("ऊ", "ू"), "uu": ("ऊ", "ू"), "e": ("ए", "े"), "ai": ("ऐ", "ै"), "ei": ("ऐ", "ै"), "ae": ("ऐ", "ै"),
    "o": ("ओ", "ो"), "au": ("औ", "ौ"), "ou": ("औ", "ौ"),
}  # fmt: skip
# A word-final "a" or "i" after a consonant is usually the long vowel (kyaa, hindee).
_FINAL_LONG = {"a": "ा", "i": "ी"}


def _roman_units(word: str) -> list[tuple[str, str]]:
    w = re.sub(r"[^a-z]", "", unicodedata.normalize("NFKD", word.lower()))
    units: list[tuple[str, str]] = []
    i = 0
    while i < len(w):
        tok = next((t for t in _ROMAN_TOKENS if w.startswith(t, i)), w[i])
        if tok in _ROMAN_VOWELS or (len(tok) == 1 and tok in "aeiou"):
            units.append(("V", tok))
        else:
            units.append(("C", tok))
        i += len(tok)
    return units


def hinglish_to_devanagari_candidates(word: str, *, retroflex: bool = False, limit: int = 12) -> list[str]:
    """Devanagari readings of a Roman word, the most likely first. The choices that Roman spelling leaves open are the
    inherent "a" between two consonants (kar-na and karna), a nasal before a stop (हिंदी and हिन्दी), a final
    "n" after a vowel (हैन and हैं) and a final "a" (क्या and क्य).
    ``retroflex=True`` reads t, d, th, dh and n as ट ड ठ ढ ण."""
    units = _roman_units(word)
    if not units:
        return []
    # Decision points: (unit index, kind). The choice 0 is the first reading listed in the docstring above.
    points: list[tuple[int, str]] = []
    for idx, (kind, tok) in enumerate(units):
        nxt = units[idx + 1][0] if idx + 1 < len(units) else ""
        prev = units[idx - 1][0] if idx else ""
        if kind == "V" and tok in _FINAL_LONG and not nxt and prev == "C":
            points.append((idx, "final-" + tok))
        elif kind != "C":
            continue
        elif tok in ("n", "m") and nxt == "C" and prev == "V":
            points.append((idx, "nasal"))
        elif tok in ("n", "m") and not nxt and prev == "V":
            points.append((idx, "final-nasal"))
        elif nxt == "C" and prev == "V" and idx > 1:
            points.append((idx, "schwa"))
    points = points[:5]
    results: list[str] = []
    for choice in itertools.product((0, 1), repeat=len(points)):
        text = _render_roman(units, dict(zip(points, choice, strict=True)), retroflex)
        if text and text not in results:
            results.append(text)
    return results[:limit]


def _render_roman(units: list[tuple[str, str]], picks: dict[tuple[int, str], int], retroflex: bool) -> str:
    out: list[str] = []
    pending = False  # a consonant waits for a vowel or a virama
    for idx, (kind, tok) in enumerate(units):
        if kind == "V":
            independent, matra = _ROMAN_VOWELS[tok if tok in _ROMAN_VOWELS else tok[0]]
            if tok in _FINAL_LONG and picks.get((idx, "final-" + tok)) == 0:
                matra = _FINAL_LONG[tok]
            out.append(matra if pending else independent)
            pending = False
            continue
        if (picks.get((idx, "nasal")) == 0 or picks.get((idx, "final-nasal")) == 1) and tok in ("n", "m"):
            out.append(_ANUSVARA)
            continue
        base = _ROMAN_CONSONANTS.get(tok, tok)
        if retroflex and base in _RETROFLEX:
            base = _RETROFLEX[base]
        if pending:
            out.append(_VIRAMA)
        out.append(base)
        pending = picks.get((idx, "schwa")) != 1  # choice 1 keeps the inherent "a": the next consonant starts afresh
    return unicodedata.normalize("NFC", "".join(out))


# Roman spellings a recogniser may swap, each applied to the whole word (a vowel written long or short, ph and f).
_ROMAN_SWAPS: tuple[tuple[str, str], ...] = (
    ("aa", "a"), ("a$", "aa"), ("ee", "i"), ("i$", "ee"), ("ii", "i"), ("oo", "u"), ("ph", "f"), ("f", "ph"),
    ("v", "w"), ("w", "v"), ("z", "j"), ("ai", "ei"), ("au", "ou"), ("chh", "ch"),
)  # fmt: skip


def hinglish_key(word: str) -> str:
    """A key two Roman spellings of the same Hindi word share (case, accents, doubled letters and the usual vowel
    and consonant spellings folded)."""
    t = "".join(c for c in unicodedata.normalize("NFD", word) if not unicodedata.category(c).startswith("M")).lower()
    for pattern, repl in (
        ("ph", "f"), ("w", "v"), ("z", "j"), ("ai|ei|ae", "e"), ("au|ou", "o"), ("ee|ii", "i"), ("oo|uu", "u"),
    ):  # fmt: skip
        t = re.sub(pattern, repl, t)
    return re.sub(r"([a-z])\1+", r"\1", t)


def _roman_spellings(roman: str) -> list[str]:
    seen = [roman]
    for pattern, repl in _ROMAN_SWAPS:
        cand = re.sub(pattern, repl, roman)
        if cand not in seen:
            seen.append(cand)
    return seen


def hotword_variants(word: str, limit: int = 12) -> list[str]:
    """Spellings a recogniser may write for one owner word, the word itself first, at most ``limit`` distinct."""
    word = unicodedata.normalize("NFC", str(word)).strip()
    if not word:
        return []
    found: list[str] = [word]

    def add(v: str) -> None:
        if v and v not in found:
            found.append(v)

    if re.search("[ऀ-ॿ]", word):
        add(fold_devanagari(word))
        add(word.replace("ँ", _ANUSVARA))
        add(word.replace(_ANUSVARA, "ँ"))
        add(fold_devanagari(word).replace(_ANUSVARA, "ँ"))
        for roman in (devanagari_to_hinglish(word), devanagari_to_hinglish(word, keep_schwa=True)):
            for spelling in _roman_spellings(roman):
                add(spelling)
    else:
        lower = word.lower()
        for spelling in _roman_spellings(lower):
            add(spelling)
        for deva in hinglish_to_devanagari_candidates(lower, limit=4):
            add(deva)
    return found[:limit]
