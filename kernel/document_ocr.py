"""Optional PDF text/OCR fallback for electron/document-extract.cjs.

PyMuPDF, Pillow, pytesseract, and the Tesseract binary are Install Manager
packages — not kernel startup requirements. This module never invents text:
it returns digital PyMuPDF text when the PDF actually has it, then OCR, then
an honest failure.
"""

from __future__ import annotations

import json
import shutil
import sys
from io import BytesIO

MAX_PAGES = 15
MIN_CHARS = 8


def _emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def probe() -> dict:
    pymupdf_ok = False
    try:
        import pymupdf as _pymupdf  # noqa: F401

        pymupdf_ok = True
    except Exception:
        try:
            import fitz as _fitz  # noqa: F401

            pymupdf_ok = True
        except Exception:
            pymupdf_ok = False
    pytesseract_ok = False
    try:
        import pytesseract  # noqa: F401

        pytesseract_ok = True
    except Exception:
        pytesseract_ok = False
    tesseract = shutil.which("tesseract")
    return {
        "ok": True,
        "pymupdf": pymupdf_ok,
        "pytesseract": pytesseract_ok,
        "tesseract": bool(tesseract),
        "tesseractPath": tesseract,
    }


def _open_pymupdf():
    try:
        import pymupdf as fitz

        return fitz
    except Exception:
        import fitz  # type: ignore

        return fitz


def _usable(text: str) -> bool:
    cleaned = " ".join((text or "").split())
    letters = sum(1 for ch in cleaned if ch.isalpha())
    return letters >= MIN_CHARS


def _ocr_page(page) -> tuple[str, str | None]:
    """Render the page and OCR it. Returns (text, error)."""
    try:
        pix = page.get_pixmap(dpi=200, alpha=False)
        png = pix.tobytes("png")
    except Exception as exc:
        return "", f"page render failed: {exc}"
    try:
        import pytesseract
        from PIL import Image
    except Exception as exc:
        try:
            tp = page.get_textpage_ocr(language="eng", dpi=200, full=True)
            text = page.get_text("text", textpage=tp) or ""
            return text, None if text.strip() else "OCR textpage was empty"
        except Exception as exc2:
            return "", f"pytesseract/Pillow missing ({exc}); textpage OCR failed ({exc2})"
    if not shutil.which("tesseract") and not getattr(
        getattr(pytesseract, "pytesseract", None), "tesseract_cmd", None
    ):
        return "", "the Tesseract OCR engine was not found on PATH"
    try:
        image = Image.open(BytesIO(png))
        return pytesseract.image_to_string(image, lang="eng") or "", None
    except Exception as exc:
        return "", str(exc)


def extract(path: str) -> dict:
    try:
        fitz = _open_pymupdf()
    except Exception as exc:
        return {
            "ok": False,
            "error": (
                "PyMuPDF is not installed in FRIDAY's Python runtime "
                f"(import failed: {exc}). Install “PyMuPDF (PDF)” and "
                "“Tesseract OCR” from the Install Manager, then retry."
            ),
        }
    try:
        doc = fitz.open(path)
    except Exception as exc:
        return {"ok": False, "error": f"This PDF could not be opened ({exc})."}

    digital_parts: list[str] = []
    for index, page in enumerate(doc):
        if index >= MAX_PAGES:
            break
        digital_parts.append(page.get_text("text") or "")
    digital = "\n".join(digital_parts).strip()
    if _usable(digital):
        return {"ok": True, "text": digital, "ocr": False, "engine": "pymupdf"}

    ocr_parts: list[str] = []
    last_error = None
    for index, page in enumerate(doc):
        if index >= MAX_PAGES:
            break
        text, error = _ocr_page(page)
        if error:
            last_error = error
        if text:
            ocr_parts.append(text)
    ocr_text = "\n".join(ocr_parts).strip()
    if _usable(ocr_text):
        return {"ok": True, "text": ocr_text, "ocr": True, "engine": "tesseract"}

    detail = last_error or "OCR produced no usable words"
    return {
        "ok": False,
        "error": (
            "This PDF has no extractable text (it may be scanned or compressed "
            f"in a way the first parser cannot unpack) and OCR failed: {detail}. "
            "Install PyMuPDF and Tesseract OCR from the Install Manager if they "
            "are missing."
        ),
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        _emit({"ok": False, "error": "A PDF path is required."})
        return 0
    if argv[1] == "--probe":
        _emit(probe())
        return 0
    _emit(extract(argv[1]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
