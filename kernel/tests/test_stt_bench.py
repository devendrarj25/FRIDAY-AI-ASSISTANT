import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import stt_bench  # noqa: E402


def test_the_normaliser_is_fixed_and_forgiving_about_case_punctuation_and_digits():
    assert stt_bench.normalise("  Namaste,  DUNIYA!  ") == "namaste duniya"
    assert stt_bench.normalise("मेरे २ दोस्त हैं।") == "मेरे 2 दोस्त हैं"
    assert stt_bench.normalise("kal ki meeting — 5 baje") == "kal ki meeting 5 baje"


def test_error_rates_count_edits_per_reference_word_or_character():
    assert stt_bench.wer("kal meeting hai", "kal meeting hai") == 0
    assert stt_bench.wer("kal meeting hai", "kal hai") == 1 / 3
    assert stt_bench.wer("kal meeting hai", "aaj meeting nahi hai") > 0.5
    assert stt_bench.wer("", "") == 0 and stt_bench.wer("", "x") == 1
    assert 0 < stt_bench.cer("meeting", "meating") < 0.2


def test_pairs_need_a_text_file_with_the_same_name(tmp_path):
    (tmp_path / "a.wav").write_bytes(b"x")
    (tmp_path / "a.txt").write_text("hello there", encoding="utf-8")
    (tmp_path / "b.wav").write_bytes(b"x")  # no text: skipped
    (tmp_path / "c.txt").write_text("orphan", encoding="utf-8")
    rows = stt_bench.pairs(tmp_path)
    assert [(p.name, t) for p, t in rows] == [("a.wav", "hello there")]


def test_models_are_ranked_by_error_with_failures_counted_not_hidden(tmp_path):
    rows = [(tmp_path / "a.wav", "kal meeting hai"), (tmp_path / "b.wav", "chai pee lo")]
    heard = {
        "small": {"a.wav": "kal meeting hai", "b.wav": "chai pee lo"},
        "tiny": {"a.wav": "kal hai", "b.wav": "chai lo"},
        "broken": {},
    }

    def hear(path, model):
        return heard[model][path.name]

    ticks = iter(range(0, 100, 2))
    out = stt_bench.score(rows, ["tiny", "small", "broken"], hear, clock=lambda: float(next(ticks)))
    assert [r["model"] for r in out] == ["small", "tiny", "broken"]
    assert out[0]["wer"] == 0 and out[1]["wer"] > 0
    assert out[2]["wer"] is None and out[2]["failed"] == 2 and out[2]["scored"] == 0


def test_the_shared_text_fixture_agrees_with_the_hand_set_edit_counts():
    import json

    fixture = json.loads(
        (Path(__file__).resolve().parents[2] / "core" / "fixtures" / "voice-wer-cases.json").read_text(encoding="utf-8")
    )
    assert len(fixture["cases"]) >= 24
    for case in fixture["cases"]:
        words = len(stt_bench.normalise(case["reference"]).split())
        assert words == case["refWords"], case["id"]
        got = stt_bench.wer(case["reference"], case["hypothesis"]) * words
        assert round(got) == case["wordEdits"], case["id"]


def test_the_roman_normaliser_folds_spelling_but_never_transliterates():
    assert stt_bench.normalise_roman("Aaj,  ka MAUSAM!") == "aj ka mausam"
    assert stt_bench.normalise_roman("āj garmī") == stt_bench.normalise_roman("aaj garmi") == "aj garmi"
    assert stt_bench.normalise_roman("kaam") == stt_bench.normalise_roman("kam")
    assert stt_bench.normalise_roman("chai") != stt_bench.normalise_roman("chaay")
    assert stt_bench.normalise_roman("मुझे चाय") == stt_bench.normalise("मुझे चाय")  # Devanagari is left as it is
    assert stt_bench.wer("mujhe chai chahiye", "मुझे चाय चाहिए", roman=True) == 1.0
    assert stt_bench.wer("mujhe kaam hai", "mujhe kam hai") == 1 / 3
    assert stt_bench.wer("mujhe kaam hai", "mujhe kam hai", roman=True) == 0
    assert stt_bench.cer("kaam", "kam", roman=True) == 0 and stt_bench.cer("kaam", "kam") > 0


def test_models_are_scored_with_the_roman_normaliser_when_asked(tmp_path):
    rows = [(tmp_path / "a.wav", "mujhe kaam hai")]

    def hear(path, model):
        return "mujhe kam hai"

    assert stt_bench.score(rows, ["m"], hear)[0]["wer"] > 0
    assert stt_bench.score(rows, ["m"], hear, roman=True)[0]["wer"] == 0


def test_the_roman_fixture_cases_agree_under_both_normalisers():
    import json

    fixture = json.loads(
        (Path(__file__).resolve().parents[2] / "core" / "fixtures" / "voice-wer-cases.json").read_text(encoding="utf-8")
    )
    roman = [case for case in fixture["cases"] if case.get("script") == "roman"]
    assert len(roman) >= 6
    for case in roman:
        words = len(stt_bench.normalise(case["reference"]).split())
        assert (
            round(stt_bench.wer(case["reference"], case["hypothesis"], roman=True) * words) == case["romanWordEdits"]
        ), case["id"]
        assert round(stt_bench.wer(case["reference"], case["hypothesis"]) * words) == case["wordEdits"], case["id"]


# --------------------------------------------------------------------------------------------------------------
# P0-bench: the folded scorer, latency, flicker, bootstrap, the regression gate, the baseline file and the set loader.
# The vectors are shared with core/__tests__/voice-eval-folded.test.ts (core/fixtures/voice-eval/fold-vectors.json).
# --------------------------------------------------------------------------------------------------------------
import hashlib  # noqa: E402
import json  # noqa: E402

import pytest  # noqa: E402

VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "core" / "fixtures" / "voice-eval" / "fold-vectors.json").read_text(
        encoding="utf-8"
    )
)


def _rows(spec: dict) -> list[dict]:
    n = len(spec["words"])
    langs = spec["lang"] if isinstance(spec["lang"], list) else [spec["lang"]] * n
    viol = spec.get("violations", [0] * n)
    return [
        {"id": f"u{i}", "lang": langs[i], "words": spec["words"][i], "edits": spec["edits"][i], "violations": viol[i]}
        for i in range(n)
    ]


@pytest.mark.parametrize("case", VECTORS["fold"], ids=lambda c: c["text"] or "empty")
def test_the_fold_gives_one_spelling_for_roman_and_devanagari(case):
    assert stt_bench.fold_tokens(case["text"]) == case["tokens"]


@pytest.mark.parametrize("case", VECTORS["counts"], ids=lambda c: c["id"])
def test_folded_counts_match_the_hand_set_vectors(case):
    got = stt_bench.folded_counts(case["reference"], case["hypothesis"])
    want = {k: v for k, v in case.items() if k not in ("id", "reference", "hypothesis")}
    assert {k: got[k] for k in want} == want


def test_folded_rates_are_transliteration_insensitive_where_the_strict_rate_is_not():
    ref, hyp = "kal subah alarm laga do", "कल सुबह अलार्म लगा दो"
    assert stt_bench.wer(ref, hyp) == 1.0
    assert stt_bench.folded_wer(ref, hyp) == 0.0
    assert stt_bench.folded_cer(ref, hyp) == 0.0
    assert stt_bench.folded_wer("send the report to rahul", "send the report to rohan") == 0.2
    assert stt_bench.folded_wer("", "") == 0.0 and stt_bench.folded_wer("", "x") == 1.0
    assert 0 < stt_bench.folded_cer("meeting", "meating") < 0.5


@pytest.mark.parametrize("case", VECTORS["mer"], ids=lambda c: c["id"])
def test_match_error_rate_is_edits_over_the_aligned_length(case):
    by_id = {c["id"]: c for c in VECTORS["counts"]}[case["id"]]
    assert stt_bench.mer(by_id["reference"], by_id["hypothesis"]) == pytest.approx(case["mer"])


def test_mer_never_exceeds_one_where_wer_can():
    assert stt_bench.folded_wer("a", "a b c d") == 3.0
    assert stt_bench.mer("a", "a b c d") == 0.75


@pytest.mark.parametrize("case", VECTORS["latency"], ids=lambda c: c["id"])
def test_latency_metrics_from_a_timeline(case):
    assert stt_bench.latency_metrics(case["timeline"]) == case["expected"]


def test_a_timeline_that_runs_backwards_is_refused():
    with pytest.raises(ValueError, match="backwards"):
        stt_bench.latency_metrics(VECTORS["latencyBackwards"])
    with pytest.raises(ValueError, match="speech_start"):
        stt_bench.latency_metrics({"audioMs": 10, "events": [{"t": 1, "kind": "final", "text": "x"}]})
    with pytest.raises(ValueError, match="kind"):
        stt_bench.latency_metrics({"audioMs": 10, "events": [{"t": 1, "kind": "bogus"}]})


@pytest.mark.parametrize("case", VECTORS["latencySummary"])
def test_percentiles_are_nearest_rank_and_ignore_missing(case):
    assert stt_bench.summarise_latency(case["values"]) == case["expected"]


def test_latency_aggregate_counts_premature_endpoints_and_unfinished_turns():
    out = stt_bench.aggregate_latency([c["timeline"] for c in VECTORS["latency"]])
    assert out["utterances"] == 4 and out["prematureEndpoints"] == 1 and out["unfinished"] == 1
    assert out["timeToFirstPartialMs"]["n"] == 3 and out["timeToFirstPartialMs"]["p50"] == 300
    assert out["finalisationLagMs"]["n"] == 3 and out["finalisationLagMs"]["p99"] == 1500
    assert out["endpointLatencyMs"]["n"] == 2 and out["rtf"]["n"] == 2
    assert stt_bench.aggregate_latency([])["utterances"] == 0


@pytest.mark.parametrize("case", VECTORS["flicker"], ids=lambda c: c["id"])
def test_flicker_counts_shown_words_that_change(case):
    assert stt_bench.flicker(case["partials"], case["final"]) == case["expected"]


def test_flicker_aggregate_is_the_sum_of_revised_over_the_sum_shown():
    parts = [stt_bench.flicker(c["partials"], c["final"]) for c in VECTORS["flicker"]]
    out = stt_bench.aggregate_flicker(parts)
    assert out["shownWords"] == 17 and out["revisedWords"] == 3 and out["revisions"] == 3
    assert out["rate"] == pytest.approx(3 / 17)
    assert stt_bench.aggregate_flicker([])["rate"] == 0


def test_bootstrap_range_is_seeded_and_brackets_the_estimate():
    spec = VECTORS["bootstrap"]
    rows = [{"edits": r["edits"], "words": r["total"]} for r in spec["rows"]]
    a = stt_bench.bootstrap_wer(rows, seed=spec["seed"], draws=spec["draws"])
    assert a == stt_bench.bootstrap_wer(rows, seed=spec["seed"], draws=spec["draws"])
    assert a["estimate"] == pytest.approx(spec["expected"]["estimate"])
    assert (a["low"], a["high"]) == (spec["expected"]["low"], spec["expected"]["high"])
    assert a["low"] <= a["estimate"] <= a["high"]
    assert stt_bench.bootstrap_wer(rows[:1], seed=1, draws=50)["low"] is None
    assert stt_bench.bootstrap_wer([], seed=1, draws=50)["estimate"] == 0


def test_the_random_stream_matches_the_scripts_generator():
    draw = stt_bench.seeded(12345)
    assert [round(draw(), 10) for _ in range(3)] == VECTORS["seeded"]["12345"]


def test_paired_bootstrap_cancels_the_difficulty_of_each_sentence():
    base = [{"id": f"u{i}", "words": 100, "edits": e} for i, e in enumerate([5, 40, 10, 60, 15, 30])]
    worse = [{**r, "edits": r["edits"] + 3} for r in base]
    out = stt_bench.paired_bootstrap(base, worse, seed=3, draws=500)
    assert out["delta"] == pytest.approx(0.03)
    assert out["low"] == pytest.approx(0.03) and out["high"] == pytest.approx(0.03)
    assert out["excludesZero"] is True
    same = stt_bench.paired_bootstrap(base, base, seed=3, draws=500)
    assert same["delta"] == 0 and same["excludesZero"] is False
    with pytest.raises(ValueError, match="same utterances"):
        stt_bench.paired_bootstrap(base, worse[:-1], seed=3, draws=10)


@pytest.mark.parametrize("case", VECTORS["gate"], ids=lambda c: c["id"])
def test_the_regression_gate_needs_both_size_and_proof(case):
    out = stt_bench.regression_gate(_rows(case["baseline"]), _rows(case["candidate"]))
    assert out["pass"] is case["pass"]
    for needle in case["reasonIncludes"]:
        assert any(needle in r for r in out["reasons"]), (needle, out["reasons"])
    if case["pass"]:
        assert out["reasons"] == []


def test_the_gate_refuses_two_runs_over_different_utterances():
    a = [{"id": "x", "lang": "en", "words": 5, "edits": 0, "violations": 0}]
    b = [{"id": "y", "lang": "en", "words": 5, "edits": 0, "violations": 0}]
    out = stt_bench.regression_gate(a, b)
    assert out["pass"] is False and "same utterances" in out["reasons"][0]


def test_the_gate_threshold_is_two_points_and_can_be_moved():
    base = _rows({"lang": "en", "words": [100] * 8, "edits": [10] * 8})
    cand = _rows({"lang": "en", "words": [100] * 8, "edits": [11] * 8})
    assert stt_bench.regression_gate(base, cand)["pass"] is True
    assert stt_bench.regression_gate(base, cand, max_wer_rise=0.005)["pass"] is False


def _samples():
    return [
        {
            "id": "a",
            "lang": "en",
            "reference": "turn on the light",
            "hypothesis": "turn on the lite",
            "partials": ["turn", "turn on the lite"],
            "timeline": VECTORS["latency"][0]["timeline"],
        },
        {"id": "b", "lang": "hi", "reference": "आज मौसम कैसा रहेगा", "hypothesis": "aaj mausam kaisa rahega"},
        {"id": "c", "lang": "hi", "reference": "माँ को फोन लगाओ", "hypothesis": "मां को फोन लगाओ"},
    ]


def test_a_run_report_has_overall_and_per_language_numbers_and_rows():
    report = stt_bench.build_report(_samples(), engine="fake", created="2026-01-01T00:00:00Z")
    assert report["schema"] == 1 and report["kind"] == "stt-baseline" and report["normaliser"] == stt_bench.FOLD_VERSION
    assert set(report["languages"]) == {"en", "hi"} and [r["id"] for r in report["rows"]] == ["a", "b", "c"]
    hi = report["languages"]["hi"]
    assert hi["utterances"] == 2 and hi["foldedWer"] <= hi["strictWer"]
    assert hi["violations"] >= 3  # the Roman Hindi sentence
    assert report["languages"]["en"]["latency"]["utterances"] == 1
    assert report["languages"]["en"]["flicker"]["shownWords"] > 0
    assert report["overall"]["utterances"] == 3 and "latency" in report["overall"]


def test_the_baseline_file_round_trips_and_is_written_whole(tmp_path):
    report = stt_bench.build_report(_samples(), engine="fake", created="2026-01-01T00:00:00Z")
    target = tmp_path / "baseline.json"
    stt_bench.write_baseline(target, report)
    assert stt_bench.read_baseline(target) == report
    assert target.read_text(encoding="utf-8").endswith("\n")
    assert [p.name for p in tmp_path.iterdir()] == ["baseline.json"]  # no half-written leftover
    cand = stt_bench.build_report(_samples(), engine="fake2", created="2026-01-02T00:00:00Z")
    assert stt_bench.regression_gate(report["rows"], cand["rows"])["pass"] is True


def test_the_baseline_reader_refuses_a_file_it_cannot_trust(tmp_path):
    report = stt_bench.build_report(_samples(), engine="fake", created="2026-01-01T00:00:00Z")
    for name, mutate, message in [
        ("schema", lambda r: r.update(schema=99), "schema"),
        ("kind", lambda r: r.update(kind="other"), "stt-baseline"),
        ("normaliser", lambda r: r.update(normaliser="fold-0"), "normaliser"),
        ("rows", lambda r: r.pop("rows"), "rows"),
    ]:
        bad = json.loads(json.dumps(report))
        mutate(bad)
        path = tmp_path / f"{name}.json"
        path.write_text(json.dumps(bad), encoding="utf-8")
        with pytest.raises(ValueError, match=message):
            stt_bench.read_baseline(path)
    broken = tmp_path / "broken.json"
    broken.write_text("{nope", encoding="utf-8")
    with pytest.raises(ValueError, match="not valid JSON"):
        stt_bench.read_baseline(broken)
    with pytest.raises(ValueError, match="cannot read"):
        stt_bench.read_baseline(tmp_path / "missing.json")


def test_the_fake_transcriber_and_clock_make_a_run_without_audio(tmp_path):
    clock = stt_bench.FakeClock()
    fake = stt_bench.FakeTranscriber(
        {"a": {"text": "turn on the lite", "partials": ["turn", "turn on"], "audioMs": 2000, "computeMs": 400}}
    )
    assert fake(tmp_path / "a.wav", "any") == "turn on the lite"
    assert clock() == 0
    clock.advance(1500)
    assert clock() == 1500
    with pytest.raises(KeyError):
        fake(tmp_path / "zzz.wav", "any")
    sample = fake.sample("a", "en", "turn on the light")
    assert sample["hypothesis"] == "turn on the lite" and sample["partials"] == ["turn", "turn on"]
    assert sample["timeline"]["audioMs"] == 2000 and sample["timeline"]["computeMs"] == 400
    assert stt_bench.latency_metrics(sample["timeline"])["rtf"] == 0.2
    out = stt_bench.score([(tmp_path / "a.wav", "turn on the light")], ["fake"], fake, clock=clock)
    assert out[0]["scored"] == 1 and out[0]["wer"] == 0.25


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _eval_set(tmp_path, audio_override=None, split="test"):
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    refs = {"t1": "turn on the light", "t2": "आज मौसम कैसा रहेगा"}
    items = []
    for i, (name, lang) in enumerate([("t1", "en"), ("t2", "hi")]):
        data = f"clip-{name}".encode()
        (audio_dir / f"{name}.wav").write_bytes(data)
        items.append(
            {
                "id": name,
                "source": "s",
                "language": lang,
                "split": split,
                "condition": "quiet",
                "speaker": f"spk{i}",
                "room": "r",
                "sha256": _sha(data),
                "referenceSha256": _sha(refs[name].encode("utf-8")),
                "durationMs": 1000,
            }
        )
    if audio_override:
        (audio_dir / "t2.wav").write_bytes(audio_override)
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"schema": 1, "id": "pub", "items": items}), encoding="utf-8")
    references = tmp_path / "refs.json"
    references.write_text(json.dumps(refs, ensure_ascii=False), encoding="utf-8")
    return manifest, references, audio_dir


def test_a_pinned_public_set_loads_only_when_every_hash_matches(tmp_path):
    manifest, refs, audio = _eval_set(tmp_path)
    pin = _sha(manifest.read_bytes())
    items = stt_bench.load_eval_set(manifest, refs, audio, pin=pin)
    assert [(i["id"], i["lang"], i["path"].name) for i in items] == [("t1", "en", "t1.wav"), ("t2", "hi", "t2.wav")]
    assert items[1]["reference"] == "आज मौसम कैसा रहेगा" and items[0]["durationMs"] == 1000


def test_a_set_that_differs_from_its_pin_gives_no_items(tmp_path):
    manifest, refs, audio = _eval_set(tmp_path, audio_override=b"swapped")
    with pytest.raises(stt_bench.EvalSetError) as err:
        stt_bench.load_eval_set(manifest, refs, audio, pin=_sha(manifest.read_bytes()))
    assert any("t2" in p and "audio" in p for p in err.value.problems)
    with pytest.raises(stt_bench.EvalSetError) as err:
        stt_bench.load_eval_set(manifest, refs, audio, pin="0" * 64)
    assert "pin" in err.value.problems[0]
    refs.write_text(json.dumps({"t1": "changed", "t2": "x"}), encoding="utf-8")
    with pytest.raises(stt_bench.EvalSetError) as err:
        stt_bench.load_eval_set(manifest, refs, audio, pin=_sha(manifest.read_bytes()))
    assert any("reference" in p for p in err.value.problems)
    (audio / "t1.wav").unlink()
    with pytest.raises(stt_bench.EvalSetError) as err:
        stt_bench.load_eval_set(manifest, refs, audio, pin=_sha(manifest.read_bytes()))
    assert any("t1" in p and "missing" in p for p in err.value.problems)


def test_a_set_inside_the_repository_is_refused_unless_it_is_the_synthetic_fixture(tmp_path):
    repo_manifest = Path(__file__).resolve().parents[2] / "core" / "fixtures" / "voice-eval" / "synthetic-manifest.json"
    with pytest.raises(stt_bench.EvalSetError, match="outside the repository"):
        stt_bench.load_eval_set(
            repo_manifest, repo_manifest, repo_manifest.parent, pin=_sha(repo_manifest.read_bytes())
        )
    assert stt_bench.is_inside_repo(repo_manifest) and not stt_bench.is_inside_repo(tmp_path)


def test_only_the_asked_split_is_loaded(tmp_path):
    manifest, refs, audio = _eval_set(tmp_path, split="dev")
    pin = _sha(manifest.read_bytes())
    assert stt_bench.load_eval_set(manifest, refs, audio, pin=pin) == []
    assert len(stt_bench.load_eval_set(manifest, refs, audio, pin=pin, split="dev")) == 2
