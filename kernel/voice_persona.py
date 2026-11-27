"""FRIDAY's own voice recipes: the default speaking voice as data, not code.

A recipe is a blend of the open female voice presets (a new synthetic voice that is none of them), a step count, a
speed scale and a finishing chain (``voice_fx``), all in ``friday_voice_recipes.json`` with the numbers that were
measured for it. ``friday`` is the default: a sweet, warm, natural, young Indian woman's tone, needing no setting.
``friday-bright`` and ``friday-calm`` lean on it. The presets ``F1`` to ``F5``, ``M1`` and ``M2`` pass through as plain
voices. The voice is synthetic and says so; it is not any one person.

Interface contract
------------------
* ``DEFAULT_ID``, ``RECIPE_VERSION``, ``DEFAULT_STEPS``; ``recipes()`` (the clean recipes, in file order);
  ``resolve_id(text)`` (any text, including an untrusted one, becomes a known id: never a path, never a new name);
  ``resolve(voice_id, voice)`` -> ``Resolved(style, steps, speed_scale, fx_spec, id, label, cache_key)``, with the
  blend made once per voice object and recipe; ``cache_key(voice_id)`` (changes with ``recipe_version`` and with
  the recipe's own content, so audio cached for an older recipe is never replayed); ``candidate(voice_id)`` (a recipe
  in the shape ``tts_eval.run_sweep`` takes).
* ``Personas(path)`` is the same on another file (tests). A file that is missing, broken or empty gives one working
  default (``F2`` with the warm chain): the voice never fails because a recipe did.
* ``voice`` is anything with ``style(name) -> friday_voice.Style`` (a ``FridayVoice``).

Nothing here downloads or writes.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import weakref
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import friday_voice
import voice_fx

DEFAULT_ID = "friday"
DEFAULT_STEPS = 5
RECIPE_FILE = Path(__file__).with_name("friday_voice_recipes.json")
PRESET_IDS = ("F1", "F2", "F3", "F4", "F5", "M1", "M2")
_ID = re.compile(r"[a-z][a-z0-9-]{0,31}")
_FALLBACK_ORDER = ("F2", "F1", "F4", "F3", "F5", "M1", "M2")
_FALLBACK = {
    "label": "FRIDAY",
    "description": "Fallback: one female voice with the warm chain.",
    "base": {"F2": 1.0},
    "steps": DEFAULT_STEPS,
    "speed_scale": 1.0,
    "fx": voice_fx.normalise_spec(voice_fx.DEFAULT_SPECS["warm"]),
    "measured": {},
}


@dataclass(frozen=True)
class Resolved:
    """One voice, ready to speak: the style, how many steps, the speed multiplier, the chain and who it is."""

    style: friday_voice.Style
    steps: int
    speed_scale: float
    fx_spec: dict[str, Any]
    id: str
    label: str
    cache_key: str = ""


def _number(value: Any, default: float, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    number = float(value)
    return min(high, max(low, number)) if number == number and abs(number) != float("inf") else default


def _clean_base(raw: Any) -> dict[str, float]:
    if not isinstance(raw, dict):
        return {}
    kept: dict[str, float] = {}
    for name, weight in raw.items():
        key = str(name).strip().upper()
        if key in PRESET_IDS and not isinstance(weight, bool) and isinstance(weight, (int, float)):
            if weight == weight and 0 < weight < float("inf"):
                kept[key] = kept.get(key, 0.0) + float(weight)
    total = sum(kept.values())
    return {k: v / total for k, v in kept.items()} if total > 0 else {}


def _clean_fx(raw: Any) -> dict[str, Any]:
    if isinstance(raw, str) and raw in voice_fx.DEFAULT_SPECS:
        return voice_fx.normalise_spec(voice_fx.DEFAULT_SPECS[raw])
    if isinstance(raw, dict):
        return voice_fx.normalise_spec(raw)
    return voice_fx.normalise_spec(voice_fx.DEFAULT_SPECS["warm"])


def _clean_measured(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    return {str(k): v for k, v in raw.items() if isinstance(v, (int, float, str, bool, list, dict)) and not callable(v)}


def _clean_recipe(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    base = _clean_base(raw.get("base"))
    if not base:
        return None
    steps = int(_number(raw.get("steps"), DEFAULT_STEPS, friday_voice.STEP_RANGE[0], friday_voice.STEP_RANGE[1]))
    return {
        "label": str(raw.get("label") or "").strip()[:60] or "FRIDAY",
        "description": str(raw.get("description") or "").strip()[:400],
        "base": base,
        "steps": steps,
        "speed_scale": _number(raw.get("speed_scale"), 1.0, 0.7, 1.3),
        "fx": _clean_fx(raw.get("fx")),
        "measured": _clean_measured(raw.get("measured")),
    }


class Personas:
    """The recipes of one file, cleaned, with the blends cached per voice object."""

    def __init__(self, path: str | Path = RECIPE_FILE) -> None:
        self.path = Path(path)
        self.version, self.default_id, self._recipes = self._load()
        self._lock = threading.Lock()
        self._blends: weakref.WeakKeyDictionary[Any, dict[str, friday_voice.Style]] = weakref.WeakKeyDictionary()

    def _load(self) -> tuple[int, str, dict[str, dict[str, Any]]]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raw = None
        data = raw if isinstance(raw, dict) else {}
        version = int(_number(data.get("recipe_version"), 1, 1, 1_000_000))
        found: dict[str, dict[str, Any]] = {}
        recipes = data.get("recipes")
        for rid, body in recipes.items() if isinstance(recipes, dict) else ():
            clean = _clean_recipe(body)
            if clean is not None and isinstance(rid, str) and _ID.fullmatch(rid) and rid.upper() not in PRESET_IDS:
                found[rid] = clean
        if not found:
            found = {DEFAULT_ID: _clean_recipe(_FALLBACK) or {}}
        default = data.get("default") if isinstance(data.get("default"), str) else DEFAULT_ID
        if default not in found:
            default = next(iter(found))
        return version, str(default), found

    # ---- ids ------------------------------------------------------------------------------------------------------
    def recipes(self) -> dict[str, dict[str, Any]]:
        """A copy of the clean recipes, the default first."""
        order = [self.default_id] + [k for k in self._recipes if k != self.default_id]
        return json.loads(json.dumps({k: self._recipes[k] for k in order}))

    def resolve_id(self, text: Any) -> str:
        """A known id for any text: a recipe id, a preset in capitals, or the default. Never a path or a new name."""
        if not isinstance(text, str) or len(text) > 64:
            return self.default_id
        key = text.strip()
        if key.lower() in self._recipes:
            return key.lower()
        if key.upper() in PRESET_IDS:
            return key.upper()
        return self.default_id

    def cache_key(self, voice_id: Any) -> str:
        """Names the voice for an audio cache: a preset is its own id; a recipe also carries the version and a hash of
        what shapes its sound (blend, steps, speed, chain), so editing a recipe changes the key even when the version
        was not bumped, and editing its label or its measured numbers does not."""
        rid = self.resolve_id(voice_id)
        if rid in PRESET_IDS:
            return rid
        recipe = self._recipes[rid]
        sound = {k: recipe[k] for k in ("base", "steps", "speed_scale", "fx")}  # what changes the audio, not the notes
        body = json.dumps(sound, sort_keys=True, separators=(",", ":"))
        return f"{rid}@v{self.version}-{hashlib.sha256(body.encode()).hexdigest()[:8]}"

    # ---- resolving ------------------------------------------------------------------------------------------------
    def _blend(self, rid: str, voice: Any) -> friday_voice.Style:
        recipe = self._recipes[rid]
        key = self.cache_key(rid)
        with self._lock:
            try:
                cached = self._blends.get(voice, {}).get(key)
            except TypeError:  # a voice that cannot be weakly referenced is simply not cached
                cached = None
        if cached is not None:
            return cached
        parts: list[friday_voice.Style] = []
        weights: list[float] = []
        for name, weight in recipe["base"].items():
            try:
                parts.append(voice.style(name))
                weights.append(weight)
            except (KeyError, OSError, ValueError):
                continue
        if not parts:
            for name in _FALLBACK_ORDER:
                try:
                    parts, weights = [voice.style(name)], [1.0]
                    break
                except (KeyError, OSError, ValueError):
                    continue
        if not parts:
            raise KeyError(f"no voice style could be read for {rid!r}")
        style = parts[0] if len(parts) == 1 else friday_voice.blend_styles(parts, weights)
        with self._lock:
            try:
                self._blends.setdefault(voice, {})[key] = style
            except TypeError:
                pass
        return style

    def resolve(self, voice_id: Any, voice: Any) -> Resolved:
        rid = self.resolve_id(voice_id)
        if rid in PRESET_IDS:
            return Resolved(
                style=voice.style(rid),
                steps=DEFAULT_STEPS,
                speed_scale=1.0,
                fx_spec=voice_fx.normalise_spec({}),
                id=rid,
                label=rid,
                cache_key=rid,
            )
        recipe = self._recipes[rid]
        return Resolved(
            style=self._blend(rid, voice),
            steps=recipe["steps"],
            speed_scale=recipe["speed_scale"],
            fx_spec=json.loads(json.dumps(recipe["fx"])),
            id=rid,
            label=recipe["label"],
            cache_key=self.cache_key(rid),
        )

    def candidate(self, voice_id: Any) -> dict[str, Any] | None:
        """A recipe (or a preset) in the shape ``tts_eval.run_sweep`` takes; None for an unknown id."""
        text = voice_id.strip() if isinstance(voice_id, str) else ""
        if text.lower() not in self._recipes and text.upper() not in PRESET_IDS:
            return None
        rid = self.resolve_id(text)
        if rid in PRESET_IDS:
            return {"id": rid, "base": {rid: 1.0}, "fx": "clean"}
        recipe = self.recipes()[rid]
        return {
            "id": rid,
            "base": recipe["base"],
            "fx": recipe["fx"],
            "steps": recipe["steps"],
            "speed_scale": recipe["speed_scale"],
        }


_SHIPPED = Personas()
RECIPE_VERSION = _SHIPPED.version


def recipes() -> dict[str, dict[str, Any]]:
    return _SHIPPED.recipes()


def resolve_id(text: Any) -> str:
    return _SHIPPED.resolve_id(text)


def resolve(voice_id: Any, voice: Any) -> Resolved:
    return _SHIPPED.resolve(voice_id, voice)


def cache_key(voice_id: Any) -> str:
    return _SHIPPED.cache_key(voice_id)


def candidate(voice_id: Any) -> dict[str, Any] | None:
    return _SHIPPED.candidate(voice_id)
