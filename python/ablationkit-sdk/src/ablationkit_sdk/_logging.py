"""A standard ``logging`` handler that records log records as ``log.record`` events."""

from __future__ import annotations

import logging

from ._run import Run, current

__all__ = ["LoggingHandler"]


class LoggingHandler(logging.Handler):
    """Send log records to the attempt's console journal (shown with stream ``log``).

    ``logging.getLogger().addHandler(LoggingHandler())``. Records also keep going to any other
    handlers; nothing is printed by this one.
    """

    def __init__(self, level: int = logging.INFO, run: Run | None = None) -> None:
        super().__init__(level)
        self._run = run

    def emit(self, record: logging.LogRecord) -> None:
        try:
            run = self._run or current()
            if not run.enabled:
                return
            run.emit(
                "log.record",
                {"level": record.levelname, "logger": record.name, "message": self.format(record)},
            )
        except Exception:
            self.handleError(record)
