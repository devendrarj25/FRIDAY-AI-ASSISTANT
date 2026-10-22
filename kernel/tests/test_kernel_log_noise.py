"""The kernel log keeps errors and startup lines, not one line per loopback RPC."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _record(message: str, level: int = logging.INFO) -> logging.LogRecord:
    return logging.LogRecord("uvicorn.error", level, __file__, 1, message, None, None)


def test_routine_connection_lines_are_dropped_and_errors_kept(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_WORKSPACE_ROOT", str(tmp_path))
    import main

    routine = main._RoutineConnectionFilter()
    assert not routine.filter(_record('127.0.0.1:53672 - "WebSocket /bridge" [accepted]'))
    assert not routine.filter(_record("connection open"))
    assert not routine.filter(_record('127.0.0.1:1 - "GET /health HTTP/1.1" 200 OK'))
    assert routine.filter(_record("Uvicorn running on http://127.0.0.1:8765"))
    assert routine.filter(_record('127.0.0.1:1 - "GET /health HTTP/1.1" 500 Internal'))
    assert routine.filter(_record("connection open", logging.ERROR))


def test_verbose_switch_keeps_every_line(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_WORKSPACE_ROOT", str(tmp_path))
    import main

    logger = logging.getLogger("websockets.server")
    for item in list(logger.filters):
        logger.removeFilter(item)
    monkeypatch.setenv("FRIDAY_KERNEL_VERBOSE_LOG", "1")
    main.quiet_routine_connections()
    assert not logger.filters
    monkeypatch.delenv("FRIDAY_KERNEL_VERBOSE_LOG")
    main.quiet_routine_connections()
    main.quiet_routine_connections()
    assert len(logger.filters) == 1
