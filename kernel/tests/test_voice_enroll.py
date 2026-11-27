"""The owner's voiceprint and personal wake template (kernel/voice_enroll.py).

The "voices" here are synthetic: a harmonic source through vowel-like resonances, with a different pitch and
resonance scale per speaker. They test the arithmetic (calibration, matching, refusing thin data, speed). They do
not show how well the engine tells real people apart; the engine says so itself (`evidence`).
"""

import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import voice_enroll as ve

RATE = 16000
VOWELS = [(730, 1090), (270, 2290), (300, 870), (530, 1840), (660, 1720), (440, 1020)]


def _resonate(x: np.ndarray, centre: float, width: float = 90.0) -> np.ndarray:
    r = np.exp(-np.pi * width / RATE)
    theta = 2 * np.pi * centre / RATE
    a1, a2 = -2 * r * np.cos(theta), r * r
    y = np.zeros_like(x)
    for n in range(2, len(x)):
        y[n] = x[n] - a1 * y[n - 1] - a2 * y[n - 2]
    return y


def segment(f0: float, formants: tuple[float, float], seconds: float, rng, shift: float) -> np.ndarray:
    n = int(seconds * RATE)
    t = np.arange(n) / RATE
    f = f0 * (1 + 0.03 * rng.standard_normal())
    src = np.zeros_like(t)
    for h in range(1, 25):
        src += np.sin(2 * np.pi * f * h * t) / h
    out = _resonate(src, formants[0] * shift) + 0.8 * _resonate(src, formants[1] * shift)
    env = np.minimum(1, np.minimum(t, seconds - t) / 0.03)
    return out * env / (np.max(np.abs(out)) + 1e-9)


def utterance(speaker: dict, ids: list[int], rng) -> np.ndarray:
    pieces = []
    for i in ids:
        length = 0.13 * (1 + 0.1 * rng.standard_normal())
        pieces.append(segment(speaker["f0"], VOWELS[i], max(0.08, length), rng, speaker["shift"]))
        pieces.append(np.zeros(int(0.02 * RATE)))
    x = np.concatenate(pieces) * 0.3
    x = np.concatenate([np.zeros(int(0.15 * RATE)), x, np.zeros(int(0.15 * RATE))])
    return (x + 0.002 * rng.standard_normal(len(x))).astype(np.float32)


OWNER = {"f0": 120.0, "shift": 1.0}
OTHER = {"f0": 215.0, "shift": 1.18}
WAKE = [0, 3, 1]  # the "word": three vowel-like parts


def sentence(speaker, rng):
    ids = [int(v) for v in rng.integers(0, 6, size=9)]
    while any(ids[i : i + 3] == WAKE for i in range(len(ids) - 2)):
        ids = [int(v) for v in rng.integers(0, 6, size=9)]
    return utterance(speaker, ids, rng)


def owner_clips(rng, wakes=8, sentences=9):
    clips = [{"id": f"w{i}", "kind": "wake", "pcm": utterance(OWNER, WAKE, rng)} for i in range(wakes)]
    clips += [
        {"id": f"s{i}", "kind": "speech", "pcm": np.concatenate([sentence(OWNER, rng), sentence(OWNER, rng)])}
        for i in range(sentences)
    ]
    return clips


def test_builds_a_ready_profile_and_recognises_the_owner():
    rng = np.random.default_rng(1)
    profile = ve.build_profile(owner_clips(rng))
    assert profile["engine"] == ve.ENGINE and "owner" in profile["evidence"]
    assert profile["speaker"]["ready"] is True, profile["speaker"]
    own = ve.score_speaker(profile, sentence(OWNER, rng))
    assert own["match"] is True and own["similarity"] >= 0.75
    other = ve.score_speaker(profile, sentence(OTHER, rng))
    assert other["match"] is False and other["similarity"] < 0.75
    assert own["similarity"] > other["similarity"]


def test_personal_wake_matches_the_owner_and_refuses_other_speech():
    rng = np.random.default_rng(2)
    profile = ve.build_profile(owner_clips(rng))
    assert profile["wake"]["ready"] is True, profile["wake"]
    assert profile["wake"]["heldOutRefusalRate"] <= ve.TARGET_WAKE_LOO_FRR
    assert profile["wake"]["falseAcceptsOnOwnSentences"] == 0
    hit = ve.score_wake(profile, utterance(OWNER, WAKE, rng))
    assert hit["matched"] is True, hit
    miss = ve.score_wake(profile, sentence(OWNER, rng))
    assert miss["matched"] is False, miss
    assert hit["distance"] < miss["distance"]


def test_thin_data_is_refused_with_reasons_and_never_raises():
    rng = np.random.default_rng(3)
    thin = ve.build_profile(owner_clips(rng, wakes=2, sentences=2))
    assert thin["speaker"]["ready"] is False and thin["speaker"]["reasons"]
    assert thin["wake"]["ready"] is False and "at least" in thin["wake"]["reasons"][0]
    assert ve.score_speaker(thin, sentence(OWNER, rng))["reason"] == "no-voiceprint"
    assert ve.score_wake(thin, sentence(OWNER, rng))["reason"] == "no-personal-wake"
    empty = ve.build_profile([])
    assert empty["speaker"]["ready"] is False
    silence = ve.build_profile([{"id": "q", "kind": "speech", "pcm": np.zeros(RATE * 2, dtype=np.float32)}])
    assert silence["speaker"]["ready"] is False


def test_a_wake_word_that_sounds_like_the_sentences_is_not_marked_ready():
    rng = np.random.default_rng(4)
    clips = owner_clips(rng, wakes=8, sentences=0)
    # sentences that contain the very same sounds as the wake word
    clips += [
        {
            "id": f"s{i}",
            "kind": "speech",
            "pcm": np.concatenate([utterance(OWNER, WAKE, rng), utterance(OWNER, WAKE, rng)]),
        }
        for i in range(7)
    ]
    wake = ve.build_profile(clips)["wake"]
    assert wake["ready"] is False and wake["reasons"]


def test_summary_hides_the_templates_and_the_centroid():
    rng = np.random.default_rng(5)
    summary = ve.public_summary(ve.build_profile(owner_clips(rng)))
    text = str(summary)
    assert summary["built"] is True
    assert "templates" not in text and "centroid" not in text and "scale" not in summary["speaker"]
    assert ve.public_summary(None) == {"built": False, "engine": ve.ENGINE, "evidence": ve.EVIDENCE}


def test_scoring_speed_is_fit_for_every_utterance():
    rng = np.random.default_rng(6)
    profile = ve.build_profile(owner_clips(rng))
    clip = utterance(OWNER, WAKE, rng)
    long_clip = sentence(OWNER, rng)
    started = time.perf_counter()
    for _ in range(3):
        ve.score_clip(profile, clip)
        ve.score_clip(profile, long_clip)
    per = (time.perf_counter() - started) / 6
    print(f"score_clip: {per * 1000:.0f} ms per clip")
    assert per < 1.5, f"{per:.2f}s per clip is too slow to run on every utterance"


def _write_wav(path, pcm):
    import wave

    data = (np.clip(pcm, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(data.tobytes())


def test_the_wake_worker_builds_loads_scores_and_clears_the_profile(tmp_path):
    import wake_word

    rng = np.random.default_rng(7)
    samples = []
    for clip in owner_clips(rng):
        path = tmp_path / f"{clip['id']}.wav"
        _write_wav(path, clip["pcm"])
        samples.append({"id": clip["id"], "kind": clip["kind"], "path": str(path)})
    built = wake_word.handle_request({"op": "enroll_build", "samples": samples, "consent": True})
    assert built["ok"] and built["summary"]["speaker"]["ready"] and built["summary"]["wake"]["ready"]
    assert "templates" not in str(built["summary"])
    probe = tmp_path / "probe.wav"
    _write_wav(probe, utterance(OWNER, WAKE, rng))
    scored = wake_word.handle_request({"op": "enroll_score", "audio": str(probe)})
    assert scored["ok"] and scored["wake"]["matched"] is True and scored["speaker"]["enrolled"] is True
    # a restarted worker has nothing until the desktop loads the profile again
    wake_word.handle_request({"op": "enroll_clear"})
    assert wake_word.handle_request({"op": "enroll_score", "audio": str(probe)})["speaker"]["enrolled"] is False
    loaded = wake_word.handle_request({"op": "enroll_load", "profile": built["profile"]})
    assert loaded["summary"]["built"] is True
    assert wake_word.handle_request({"op": "enroll_score", "audio": str(probe)})["wake"]["matched"] is True
    assert wake_word.handle_request({"op": "enroll_score", "audio": str(tmp_path / "missing.wav")})["ok"] is False
    wake_word.handle_request({"op": "enroll_clear"})


def test_the_owner_baseline_is_measured_by_the_apps_own_prosody_function():
    rng = np.random.default_rng(8)
    profile = ve.build_profile(owner_clips(rng))
    base = profile["baseline"]
    assert base and base["clips"] >= 4
    # an owner at 120 Hz is read near 120 Hz, not at a pitch the app would never see
    assert 90 <= base["pitchHz"] <= 170
    assert base["energyDbfs"] < 0 and base["pitchSpreadSemitones"] >= 0
    assert ve.public_summary(profile)["baseline"] == base
    # too few measurable clips: no baseline, and the profile still builds
    assert ve.build_profile(owner_clips(rng, wakes=6, sentences=2))["baseline"] is None


def test_the_wake_worker_builds_no_voiceprint_without_the_owners_consent(tmp_path):
    import wake_word

    rng = np.random.default_rng(11)
    samples = []
    for clip in owner_clips(rng):
        path = tmp_path / f"{clip['id']}.wav"
        _write_wav(path, clip["pcm"])
        samples.append({"id": clip["id"], "kind": clip["kind"], "path": str(path)})
    wake_word.handle_request({"op": "enroll_clear"})
    for consent in (None, False, "yes", 1):
        req = {"op": "enroll_build", "samples": samples}
        if consent is not None:
            req["consent"] = consent
        refused = wake_word.handle_request(req)
        assert refused["ok"] is False and refused["reason"] == "consent-required"
        assert "profile" not in refused
    # nothing was kept in the worker either
    assert wake_word.handle_request({"op": "enroll_summary"})["summary"]["built"] is False


def test_the_owner_embedding_is_the_unit_mean_of_speech_clips_and_absent_without_a_model():
    rng = np.random.default_rng(21)
    clips = owner_clips(rng)
    seen = []

    def embed(pcm):
        seen.append(len(pcm))
        out = np.zeros(256)
        out[3] = 2.0
        out[7] = 0.5
        return out

    vec = ve.owner_embedding(clips, embed=embed)
    assert vec is not None and len(vec) == 256
    assert abs(float(np.linalg.norm(vec)) - 1.0) < 1e-9
    # wake takes are not used: only the speech clips were embedded
    assert len(seen) == sum(1 for c in clips if c["kind"] != "wake")
    # too few speech clips, or an embedder that fails, leave the speaker unknown
    assert ve.owner_embedding(clips[:2], embed=embed) is None

    def broken(_pcm):
        raise RuntimeError("no runtime")

    assert ve.owner_embedding(clips, embed=broken) is None
