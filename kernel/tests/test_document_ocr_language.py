"""A scanned PDF is read with the same OCR language the screen reader uses: hin+eng when Hindi data is installed."""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import control  # noqa: E402
import document_ocr  # noqa: E402


class FakePage:
    def __init__(self):
        self.textpage_language: str | None = None

    def get_pixmap(self, dpi=200, alpha=False):
        return types.SimpleNamespace(tobytes=lambda fmt: b"png")

    def get_textpage_ocr(self, language="eng", dpi=200, full=True):
        self.textpage_language = language
        return object()

    def get_text(self, kind, textpage=None):
        return "text from the page"


def _modules(langs: list[str]):
    pytesseract = types.SimpleNamespace(
        pytesseract=types.SimpleNamespace(tesseract_cmd="/opt/tesseract"),
        image_to_string=lambda image, lang: langs.append(lang) or "नमस्ते hello world",
    )
    image_module = types.SimpleNamespace(open=lambda data: object())
    pil = types.SimpleNamespace(Image=image_module)
    return {"pytesseract": pytesseract, "PIL": pil, "PIL.Image": image_module}


class DocumentOcrLanguageTests(unittest.TestCase):
    def _ocr(self, installed: list[str]):
        used: list[str] = []
        with (
            mock.patch.dict(sys.modules, _modules(used)),
            mock.patch.object(document_ocr.shutil, "which", return_value="/opt/tesseract"),
            mock.patch.object(control, "_tesseract_languages", return_value=installed),
            mock.patch.object(control, "_user_tessdata", return_value=None),
            mock.patch.dict(control._OCR_LANG_CACHE, clear=True),
        ):
            text, error = document_ocr._ocr_page(FakePage())
        return used, text, error

    def test_uses_hindi_plus_english_when_the_hindi_data_is_installed(self):
        used, text, error = self._ocr(["eng", "hin", "osd"])
        self.assertEqual(used, ["hin+eng"])
        self.assertIsNone(error)
        self.assertIn("नमस्ते", text)

    def test_keeps_english_when_there_is_no_hindi_data(self):
        used, _text, error = self._ocr(["eng", "osd"])
        self.assertEqual(used, ["eng"])
        self.assertIsNone(error)

    def test_falls_back_to_english_when_the_language_probe_breaks(self):
        used: list[str] = []
        with (
            mock.patch.dict(sys.modules, _modules(used)),
            mock.patch.object(document_ocr.shutil, "which", return_value="/opt/tesseract"),
            mock.patch.object(control, "ocr_language", side_effect=RuntimeError("probe failed")),
        ):
            document_ocr._ocr_page(FakePage())
        self.assertEqual(used, ["eng"])

    def test_the_pymupdf_textpage_fallback_uses_the_same_language(self):
        page = FakePage()
        broken = {"pytesseract": None}
        with (
            mock.patch.dict(sys.modules, broken),
            mock.patch.object(document_ocr.shutil, "which", return_value="/opt/tesseract"),
            mock.patch.object(control, "_tesseract_languages", return_value=["eng", "hin"]),
            mock.patch.object(control, "_user_tessdata", return_value=None),
            mock.patch.dict(control._OCR_LANG_CACHE, clear=True),
        ):
            document_ocr._ocr_page(page)
        self.assertEqual(page.textpage_language, "hin+eng")


if __name__ == "__main__":
    unittest.main()
