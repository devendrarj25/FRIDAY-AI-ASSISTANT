"""OCR reads Hindi, English and Hinglish screens: hin+eng when the Hindi data is installed, else eng."""

from __future__ import annotations

import os
import sys
import types
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import control  # noqa: E402

LIST_FIVE = 'List of available languages in "C:\\Program Files\\Tesseract-OCR/tessdata/" (3):\r\neng\r\nhin\r\nosd\r\n'


def _completed(stdout: str = "", stderr: str = ""):
    return types.SimpleNamespace(stdout=stdout, stderr=stderr, returncode=0)


class LanguageListTests(unittest.TestCase):
    def test_reads_codes_from_stdout_or_stderr(self):
        with mock.patch.object(control.subprocess, "run", return_value=_completed(stdout=LIST_FIVE)):
            self.assertEqual(control._tesseract_languages("t"), ["eng", "hin", "osd"])
        with mock.patch.object(control.subprocess, "run", return_value=_completed(stderr=LIST_FIVE)):
            self.assertEqual(control._tesseract_languages("t"), ["eng", "hin", "osd"])

    def test_ignores_error_text_and_a_missing_engine(self):
        noise = "Error opening data file\nFailed loading language 'hin'\n"
        with mock.patch.object(control.subprocess, "run", return_value=_completed(stderr=noise)):
            self.assertEqual(control._tesseract_languages("t"), [])
        with mock.patch.object(control.subprocess, "run", side_effect=FileNotFoundError):
            self.assertEqual(control._tesseract_languages("missing"), [])


class OcrLanguageTests(unittest.TestCase):
    def setUp(self):
        control._OCR_LANG_CACHE.clear()
        self.addCleanup(control._OCR_LANG_CACHE.clear)

    def test_hindi_and_english_when_both_installed(self):
        with mock.patch.object(control, "_tesseract_languages", return_value=["eng", "hin", "osd"]):
            self.assertEqual(control.ocr_language("t"), "hin+eng")

    def test_english_only_without_hindi_data(self):
        with mock.patch.object(control, "_tesseract_languages", return_value=["eng", "osd"]):
            self.assertEqual(control.ocr_language("t"), "eng")
        control._OCR_LANG_CACHE.clear()
        with mock.patch.object(control, "_tesseract_languages", return_value=[]):
            self.assertEqual(control.ocr_language("t"), "eng")

    def test_hindi_alone_when_english_data_is_missing(self):
        with mock.patch.object(control, "_tesseract_languages", return_value=["hin"]):
            self.assertEqual(control.ocr_language("t"), "hin")

    def test_per_user_data_folder_is_used_and_pointed_at(self):
        folder = os.path.join(os.sep, "u", "FRIDAY", "tools", "tessdata")

        def languages(_binary, env=None):
            if env and env.get("TESSDATA_PREFIX") == folder:
                return ["eng", "hin", "osd"]
            return ["eng"]

        with (
            mock.patch.object(control, "_tesseract_languages", side_effect=languages),
            mock.patch.object(control, "_user_tessdata", return_value=folder),
            mock.patch.object(control.os.path, "isfile", return_value=True),
            mock.patch.dict(os.environ, {}, clear=False),
        ):
            os.environ.pop("TESSDATA_PREFIX", None)
            self.assertEqual(control.ocr_language("t"), "hin+eng")
            self.assertEqual(os.environ.get("TESSDATA_PREFIX"), folder)

    def test_answer_is_cached_for_a_minute(self):
        with mock.patch.object(control, "_tesseract_languages", return_value=["eng", "hin"]) as spy:
            control.ocr_language("t")
            control.ocr_language("t")
        self.assertEqual(spy.call_count, 1)


class BinaryTests(unittest.TestCase):
    def test_finds_the_engine_in_program_files_when_path_misses_it(self):
        exe = os.path.join("C:\\PF", "Tesseract-OCR", "tesseract.exe")
        env = {"PATH": "C:\\Windows", "ProgramFiles": "C:\\PF"}
        with (
            mock.patch.object(control, "WINDOWS", True),
            mock.patch.object(control, "child_env", return_value=env),
            mock.patch.object(control.shutil, "which", return_value=None),
            mock.patch.object(control.os.path, "isfile", side_effect=lambda p: p == exe),
        ):
            self.assertEqual(control._tesseract_binary(), exe)

    def test_prefers_path_and_returns_none_when_nowhere(self):
        with (
            mock.patch.object(control, "child_env", return_value={"PATH": "x"}),
            mock.patch.object(control.shutil, "which", return_value="/usr/bin/tesseract"),
        ):
            self.assertEqual(control._tesseract_binary(), "/usr/bin/tesseract")
        with (
            mock.patch.object(control, "WINDOWS", False),
            mock.patch.object(control, "child_env", return_value={"PATH": "x"}),
            mock.patch.object(control.shutil, "which", return_value=None),
        ):
            self.assertIsNone(control._tesseract_binary())


class ReadTextTests(unittest.TestCase):
    def setUp(self):
        control._OCR_LANG_CACHE.clear()
        self.addCleanup(control._OCR_LANG_CACHE.clear)
        self.langs: list[str] = []

        class Sct:
            monitors = [None, {"left": 0, "top": 0, "width": 2, "height": 2}]

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def grab(self, box):
                return types.SimpleNamespace(size=(2, 2), bgra=bytes(16))

        mss_mod = types.SimpleNamespace(mss=lambda: Sct())
        outer = self

        class Tess:
            tesseract_cmd = "tesseract"

        def image_to_string(_image, lang):
            outer.langs.append(lang)
            return "नमस्ते hello"

        py = types.SimpleNamespace(pytesseract=Tess, image_to_string=image_to_string)

        def require(module, package):
            return mss_mod if module == "mss" else py

        self.require = require
        self.tess = Tess

    def _run(self, **kwargs):
        pil: Any = types.ModuleType("PIL")
        image = types.SimpleNamespace(frombytes=lambda *a, **k: object())
        pil.Image = image
        with (
            mock.patch.object(control, "_require", side_effect=self.require),
            mock.patch.dict(sys.modules, {"PIL": pil, "PIL.Image": image}),
        ):
            return control.read_text(**kwargs)

    def test_defaults_to_hindi_plus_english_when_installed(self):
        with (
            mock.patch.object(control, "_tesseract_binary", return_value="/opt/tesseract"),
            mock.patch.object(control, "_tesseract_languages", return_value=["eng", "hin"]),
        ):
            result = self._run()
        self.assertEqual(self.langs, ["hin+eng"])
        self.assertEqual(result["lang"], "hin+eng")
        self.assertEqual(self.tess.tesseract_cmd, "/opt/tesseract")
        self.assertIn("नमस्ते", result["text"])

    def test_english_when_there_is_no_hindi_data_and_an_explicit_lang_wins(self):
        with (
            mock.patch.object(control, "_tesseract_binary", return_value="/opt/tesseract"),
            mock.patch.object(control, "_tesseract_languages", return_value=["eng"]),
        ):
            self._run()
            self._run(lang="deu")
        self.assertEqual(self.langs, ["eng", "deu"])

    def test_a_missing_engine_is_an_honest_error(self):
        with mock.patch.object(control, "_tesseract_binary", return_value=None):
            with self.assertRaises(control.ControlError):
                self._run()


if __name__ == "__main__":
    unittest.main()
