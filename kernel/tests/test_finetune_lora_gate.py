"""The adapter trainer's gate: probe, eval.json, GGUF conversion, the no-drop rule and rollback.

Everything heavy is replaced by fakes: no torch, no model, no network, no real convert script run.
"""

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

KERNEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KERNEL))

import finetune_lora  # noqa: E402

BASE_SHA = "a" * 64
GOOD = {"heldout": 0.62, "safety": 0.98, "toolcall": 0.9, "language": 0.8}


def make_eval(**scores: float) -> dict:
    return {
        "v": 1,
        "id": "ft-1",
        "baseSha256": BASE_SHA,
        "scores": {**GOOD, **scores},
        "steps": 40,
        "at": "2026-11-27T10:00:00Z",
    }


class Clock:
    """A fake monotonic clock that moves only when a fake step runs: each step costs `tick` seconds."""

    def __init__(self, tick: float) -> None:
        self.now = 0.0
        self.tick = tick

    def __call__(self) -> float:
        return self.now

    def step(self) -> None:
        self.now += self.tick


# ---- torch stays out of the module and the requirements --------------------------------------------------------


def test_module_imports_without_any_training_library() -> None:
    code = (
        "import sys\n"
        "for n in ('torch','peft','transformers','datasets'): sys.modules[n] = None\n"
        f"sys.path.insert(0, {str(KERNEL)!r})\n"
        "import finetune_lora\n"
        "assert not any(m in sys.modules and sys.modules[m] is not None for m in ('torch','peft'))\n"
        "print('ok')\n"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=False, timeout=60)
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "ok"


def test_kernel_requirements_never_list_torch() -> None:
    files = sorted(KERNEL.glob("requirements*.txt"))
    assert files
    for path in files:
        for line in path.read_text(encoding="utf-8").splitlines():
            entry = line.split("#", 1)[0].strip().lower()
            assert not re.match(r"(torch|torchaudio|torchvision|triton)(\b|[=<>~!\[;])", entry), (path.name, line)


# ---- probe ------------------------------------------------------------------------------------------------------


def test_probe_goes_when_the_projected_run_fits_the_cap() -> None:
    clock = Clock(0.5)
    result = finetune_lora.probe(20, step_fn=clock.step, clock=clock, planned_steps=200, cap_seconds=600)
    assert clock.now == pytest.approx(10.0)
    assert result["steps"] == 20
    assert result["secPerStep"] == pytest.approx(0.5)
    assert result["projectedSeconds"] == pytest.approx(100.0)
    assert result["go"] is True


def test_probe_says_no_go_when_the_run_would_pass_the_cap() -> None:
    clock = Clock(5.0)
    result = finetune_lora.probe(20, step_fn=clock.step, clock=clock, planned_steps=500, cap_seconds=600)
    assert result["go"] is False
    assert "cap" in result["reason"]


def test_probe_no_go_when_a_step_fails_or_libraries_are_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom() -> None:
        raise RuntimeError("out of memory")

    failed = finetune_lora.probe(20, step_fn=boom, clock=Clock(1.0))
    assert failed["go"] is False and "out of memory" in failed["reason"]

    monkeypatch.setitem(sys.modules, "torch", None)
    missing = finetune_lora.probe(20, clock=Clock(1.0))
    assert missing["go"] is False and "torch" in missing["reason"]


# ---- eval.json (schema frozen in D11) ---------------------------------------------------------------------------


def test_eval_json_round_trips_the_frozen_schema(tmp_path: Path) -> None:
    path = tmp_path / "ft-1" / "eval.json"
    finetune_lora.write_eval_json(path, make_eval())
    assert json.loads(path.read_text(encoding="utf-8")) == make_eval()
    assert not list(path.parent.glob("*.tmp"))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.pop("baseSha256"),
        lambda d: d.update(baseSha256="xyz"),
        lambda d: d["scores"].pop("safety"),
        lambda d: d["scores"].update(extra=0.5),
        lambda d: d["scores"].update(language=1.5),
        lambda d: d["scores"].update(heldout=float("nan")),
        lambda d: d.update(v=2),
        lambda d: d.update(id=""),
        lambda d: d.update(steps=-1),
    ],
)
def test_eval_json_refuses_a_bad_shape_and_writes_nothing(tmp_path: Path, mutate) -> None:
    data = make_eval()
    mutate(data)
    path = tmp_path / "eval.json"
    with pytest.raises(ValueError):
        finetune_lora.write_eval_json(path, data)
    assert not path.exists()


# ---- the gate: no score may drop --------------------------------------------------------------------------------


def test_gate_passes_when_nothing_drops() -> None:
    better = {**GOOD, "heldout": 0.7}
    assert finetune_lora.gate(GOOD, better) == {"ok": True, "dropped": []}
    assert finetune_lora.gate(GOOD, dict(GOOD))["ok"] is True
    assert finetune_lora.gate(make_eval(), make_eval(heldout=0.9))["ok"] is True  # eval.json shapes work too


def test_gate_fails_on_any_single_drop_or_missing_score() -> None:
    for key in GOOD:
        worse = {**GOOD, key: GOOD[key] - 0.01}
        verdict = finetune_lora.gate(GOOD, worse)
        assert verdict["ok"] is False and verdict["dropped"] == [key]
    partial = {k: v for k, v in GOOD.items() if k != "toolcall"}
    assert finetune_lora.gate(GOOD, partial)["dropped"] == ["toolcall"]
    assert finetune_lora.gate(GOOD, {**GOOD, "safety": float("nan")})["ok"] is False
    with pytest.raises(ValueError):
        finetune_lora.gate({"heldout": 0.5}, GOOD)


# ---- GGUF conversion through an injected runner -----------------------------------------------------------------


@pytest.fixture
def convert_setup(tmp_path: Path):
    adapter = tmp_path / "adapters" / "ft-1"
    adapter.mkdir(parents=True)
    (adapter / "adapter_config.json").write_text("{}", encoding="utf-8")
    script = tmp_path / "llama" / "convert_lora_to_gguf.py"
    script.parent.mkdir()
    script.write_text("print('convert')\n", encoding="utf-8")
    sha = hashlib.sha256(script.read_bytes()).hexdigest()
    trainer = tmp_path / "trainer-venv" / "Scripts" / "python.exe"
    return {"adapter": adapter, "script": script, "sha": sha, "trainer": str(trainer), "base": str(tmp_path / "base")}


def run_convert(setup: dict, runner, **over):
    args = {
        "trainer_python": setup["trainer"],
        "script": setup["script"],
        "script_sha256": setup["sha"],
        "base_dir": setup["base"],
    }
    args.update(over)
    return finetune_lora.convert_to_gguf(setup["adapter"], runner, **args)


def test_convert_runs_the_pinned_script_from_the_trainer_venv(convert_setup) -> None:
    seen: list[list[str]] = []

    def runner(argv: list[str]) -> int:
        seen.append(argv)
        Path(argv[argv.index("--outfile") + 1]).write_bytes(b"GGUF")
        return 0

    out = run_convert(convert_setup, runner)
    assert out == convert_setup["adapter"] / "adapter.gguf"
    assert out.read_bytes() == b"GGUF"
    argv = seen[0]
    assert argv[0] == convert_setup["trainer"] and argv[0] != sys.executable
    assert argv[1] == str(convert_setup["script"])
    assert argv[argv.index("--base") + 1] == convert_setup["base"]
    assert argv[-1] == str(convert_setup["adapter"])
    assert finetune_lora.LLAMA_CPP_TAG == "b12230"


def test_convert_refuses_a_script_that_does_not_match_its_pin(convert_setup) -> None:
    called: list[object] = []
    with pytest.raises(finetune_lora.ConvertError, match="sha"):
        run_convert(convert_setup, lambda argv: called.append(argv) or 0, script_sha256="0" * 64)
    with pytest.raises(finetune_lora.ConvertError, match="sha"):
        run_convert(convert_setup, lambda argv: called.append(argv) or 0, script_sha256="")
    assert called == []


def test_convert_refuses_the_voice_environment_as_trainer(convert_setup) -> None:
    called: list[object] = []
    for python in (sys.executable, str(Path(sys.prefix) / "bin" / "python"), ""):
        with pytest.raises(finetune_lora.ConvertError, match="trainer"):
            run_convert(convert_setup, lambda argv: called.append(argv) or 0, trainer_python=python)
    assert called == []


def test_convert_fails_on_a_bad_exit_or_a_missing_output(convert_setup) -> None:
    with pytest.raises(finetune_lora.ConvertError, match="exit"):
        run_convert(convert_setup, lambda argv: 2)
    with pytest.raises(finetune_lora.ConvertError, match="adapter.gguf"):
        run_convert(convert_setup, lambda argv: 0)
    assert not (convert_setup["adapter"] / "adapter.gguf").exists()


# ---- the convert script's sha256 is pinned in code, a job may only repeat it ------------------------------------


@pytest.fixture(autouse=True)
def _pin_the_fake_convert_script(request, monkeypatch) -> None:
    """The convert_setup tests run a fake script, so the code pin is pointed at that fake for them only."""
    if "convert_setup" in request.fixturenames:
        monkeypatch.setattr(finetune_lora, "CONVERT_SCRIPT_SHA256", request.getfixturevalue("convert_setup")["sha"])


def make_script(tmp_path: Path, text: str = "print('x')\n") -> tuple[dict, str]:
    adapter = tmp_path / "adapters" / "ft-9"
    adapter.mkdir(parents=True)
    script = tmp_path / "llama" / "convert_lora_to_gguf.py"
    script.parent.mkdir()
    script.write_text(text, encoding="utf-8")
    sha = hashlib.sha256(script.read_bytes()).hexdigest()
    return {
        "adapter": adapter,
        "script": script,
        "trainer": str(tmp_path / "trainer-venv" / "Scripts" / "python.exe"),
        "base": str(tmp_path / "base"),
    }, sha


def test_the_real_convert_pin_is_a_sha256_in_code() -> None:
    assert re.fullmatch(r"[0-9a-f]{64}", finetune_lora.CONVERT_SCRIPT_SHA256 or "")
    assert finetune_lora.LLAMA_CPP_TAG == "b12230"


def test_a_job_supplied_sha_never_overrides_the_code_pin(tmp_path: Path, monkeypatch) -> None:
    setup, sha = make_script(tmp_path)
    called: list[object] = []
    # the script matches the job's claim but NOT the pin in code: refused, the runner never runs
    with pytest.raises(finetune_lora.ConvertError, match="sha256"):
        finetune_lora.convert_to_gguf(
            setup["adapter"],
            lambda argv: called.append(argv) or 0,
            trainer_python=setup["trainer"],
            script=setup["script"],
            script_sha256=sha,
            base_dir=setup["base"],
        )
    assert called == []
    # a job that says nothing uses the code pin; a mismatching script is still refused
    with pytest.raises(finetune_lora.ConvertError, match="sha256"):
        finetune_lora.convert_to_gguf(
            setup["adapter"],
            lambda argv: called.append(argv) or 0,
            trainer_python=setup["trainer"],
            script=setup["script"],
            base_dir=setup["base"],
        )
    assert called == []
    # pin the fake in code: a job that says nothing, or repeats it in any case, now converts
    monkeypatch.setattr(finetune_lora, "CONVERT_SCRIPT_SHA256", sha)
    for claim in (None, sha, sha.upper()):
        called.clear()

        def runner(argv: list[str]) -> int:
            Path(argv[argv.index("--outfile") + 1]).write_bytes(b"GGUF")
            called.append(argv)
            return 0

        out = finetune_lora.convert_to_gguf(
            setup["adapter"],
            runner,
            trainer_python=setup["trainer"],
            script=setup["script"],
            script_sha256=claim,
            base_dir=setup["base"],
        )
        assert out.name == "adapter.gguf" and len(called) == 1


def test_a_missing_code_pin_fails_closed(tmp_path: Path, monkeypatch) -> None:
    setup, sha = make_script(tmp_path)
    monkeypatch.setattr(finetune_lora, "CONVERT_SCRIPT_SHA256", None)
    called: list[object] = []
    for claim in (None, sha):
        with pytest.raises(finetune_lora.ConvertError, match="pinned"):
            finetune_lora.convert_to_gguf(
                setup["adapter"],
                lambda argv: called.append(argv) or 0,
                trainer_python=setup["trainer"],
                script=setup["script"],
                script_sha256=claim,
                base_dir=setup["base"],
            )
    assert called == []


# ---- rollback keeps the previous adapter ------------------------------------------------------------------------


def make_adapters(root: Path, active: str | None = "ft-0", previous: str | None = None) -> None:
    for name in ("ft-0", "ft-1", "ft-old"):
        (root / name).mkdir(parents=True)
        (root / name / "adapter.gguf").write_bytes(b"x")
    if active:
        (root / "active.json").write_text(json.dumps({"id": active, "previous": previous}), encoding="utf-8")


def test_rollback_deletes_only_the_new_adapter(tmp_path: Path) -> None:
    make_adapters(tmp_path, active="ft-0", previous="ft-old")
    assert finetune_lora.rollback_adapter(tmp_path, "ft-1") is True
    assert not (tmp_path / "ft-1").exists()
    assert (tmp_path / "ft-0" / "adapter.gguf").exists() and (tmp_path / "ft-old" / "adapter.gguf").exists()


@pytest.mark.parametrize("target", ["ft-0", "ft-old", "..", ".", "../ft-0", "a/b", ""])
def test_rollback_never_touches_the_active_or_previous_or_outside(tmp_path: Path, target: str) -> None:
    root = tmp_path / "adapters"
    root.mkdir()
    make_adapters(root, active="ft-0", previous="ft-old")
    assert finetune_lora.rollback_adapter(root, target) is False
    assert (root / "ft-0").exists() and (root / "ft-old").exists() and root.exists()


def test_finish_candidate_promotes_or_rolls_back(tmp_path: Path) -> None:
    make_adapters(tmp_path, active="ft-0", previous=None)
    good = finetune_lora.finish_candidate(tmp_path, "ft-1", make_eval(heldout=0.7), before=GOOD)
    assert good == {"promoted": True, "dropped": [], "rolledBack": False}
    assert (tmp_path / "ft-1").exists()
    assert json.loads((tmp_path / "ft-1" / "eval.json").read_text(encoding="utf-8"))["scores"]["heldout"] == 0.7

    bad = finetune_lora.finish_candidate(tmp_path, "ft-1", make_eval(safety=0.5), before=GOOD)
    assert bad == {"promoted": False, "dropped": ["safety"], "rolledBack": True}
    assert not (tmp_path / "ft-1").exists()
    assert (tmp_path / "ft-0" / "adapter.gguf").exists()


# ---- the job entry points ---------------------------------------------------------------------------------------


def run_job(
    monkeypatch: pytest.MonkeyPatch, job: dict, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> list[dict]:
    config = tmp_path / "job.json"
    config.write_text(json.dumps(job), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["finetune_lora.py", "--config", str(config)])
    try:
        finetune_lora.main()
    except SystemExit:
        pass
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]


def test_gate_mode_rolls_back_a_worse_adapter(monkeypatch, capsys, tmp_path: Path) -> None:
    make_adapters(tmp_path, active="ft-0", previous=None)
    job = {"mode": "gate", "adaptersRoot": str(tmp_path), "id": "ft-1", "eval": make_eval(language=0.1), "before": GOOD}
    last = run_job(monkeypatch, job, tmp_path, capsys)[-1]
    assert last["stage"] == "gated" and last["promoted"] is False and last["dropped"] == ["language"]
    assert not (tmp_path / "ft-1").exists() and (tmp_path / "ft-0").exists()


def test_probe_mode_reports_no_go_without_torch(monkeypatch, capsys, tmp_path: Path) -> None:
    monkeypatch.setitem(sys.modules, "torch", None)
    last = run_job(monkeypatch, {"mode": "probe"}, tmp_path, capsys)[-1]
    assert last["stage"] == "probe" and last["go"] is False
