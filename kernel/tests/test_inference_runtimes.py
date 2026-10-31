import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from runtimes import RuntimeManager  # noqa: E402


def test_inference_runtimes_reports_each_runtime_without_importing_torch():
    manager = RuntimeManager.__new__(RuntimeManager)
    before = "torch" in sys.modules
    info = manager.inference_runtimes()
    assert set(info) == {"onnxruntime", "diffusers", "torch"}
    assert isinstance(info["onnxruntime"]["providers"], list)
    assert info["onnxruntime"]["gpu"] in (None, "CUDAExecutionProvider", "DmlExecutionProvider")
    assert ("torch" in sys.modules) == before


def test_the_cpu_provider_is_there_when_onnxruntime_is_installed():
    manager = RuntimeManager.__new__(RuntimeManager)
    onnx = manager.inference_runtimes()["onnxruntime"]
    if onnx["installed"]:
        assert "CPUExecutionProvider" in onnx["providers"]
    else:
        assert onnx["providers"] == []
