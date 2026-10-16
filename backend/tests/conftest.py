# conftest.py — Pre-stub only the I/O modules that need credentials.
# The real app.services package (with its __path__) is left intact so
# Python can find adaptive_baseline_service.py on disk.
import sys
import os
import logging
from types import ModuleType
from unittest.mock import MagicMock

# ─── Ensure backend/ is on sys.path so "import app.xxx" resolves to disk ─────
backend_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if backend_root not in sys.path:
    sys.path.insert(0, backend_root)


def _mod(name: str) -> ModuleType:
    m = ModuleType(name)
    return m


# ─── Stub pydantic_settings (not installed on Python 3.14 in this env) ───────
if "pydantic_settings" not in sys.modules:
    ps = _mod("pydantic_settings")

    class _BaseSettings:
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)

    class _SettingsConfigDict(dict):
        def __new__(cls, **kwargs):
            return super().__new__(cls)

    ps.BaseSettings = _BaseSettings
    ps.SettingsConfigDict = _SettingsConfigDict
    sys.modules["pydantic_settings"] = ps


# ─── Stub app.utils.logger so it doesn't chain to real config ────────────────
# Must be done BEFORE importing adaptive_baseline_service.
if "app.utils.logger" not in sys.modules:
    # Make sure app and app.utils exist as packages
    import importlib
    import importlib.util

    # Try to find and partially load the real app package
    # so its __path__ is set correctly.
    import app  # noqa: F401  — loads from disk since backend/ is on sys.path
    import app.utils  # noqa: F401

    # Replace only the logger module with a stub
    aul = _mod("app.utils.logger")
    def _get_logger(name: str) -> logging.Logger:
        return logging.getLogger(f"marudam.{name}")
    aul.get_logger = _get_logger
    sys.modules["app.utils.logger"] = aul


# ─── Stub supabase_service (needs credentials) ───────────────────────────────
supa_stub = _mod("app.services.supabase_service")
supa_stub.get_bounded_reading_history   = MagicMock(return_value=[])
supa_stub.upsert_adaptive_baseline      = MagicMock(return_value=True)
supa_stub.load_adaptive_baselines       = MagicMock(return_value=[])
supa_stub.upsert_anomaly                = MagicMock(return_value="mock-anomaly-id")
supa_stub.upsert_reading                = MagicMock(return_value=True)
supa_stub.get_latest_reading            = MagicMock(return_value=None)
supa_stub.get_recent_anomalies          = MagicMock(return_value=[])
supa_stub.get_latest_two_field_readings = MagicMock(return_value={"field_1": None, "field_2": None})
supa_stub.get_client                    = MagicMock(return_value=None)
sys.modules["app.services.supabase_service"] = supa_stub
