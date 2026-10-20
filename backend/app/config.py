# =============================================================================
# MARUDAM Backend — Configuration
# =============================================================================
# All settings are loaded from environment variables (via .env file).
# Never hard-code secrets here.
# =============================================================================
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import model_validator
from typing import Optional

_backend_dir = Path(__file__).resolve().parent.parent
_backend_env = _backend_dir / ".env"
_backend_env_local = _backend_dir / ".env.local"
_root_env = _backend_dir.parent / ".env"
_root_env_local = _backend_dir.parent / ".env.local"
_env_candidates = [
    str(_backend_env),
    str(_backend_env_local),
    str(_root_env),
    str(_root_env_local),
    ".env",
    ".env.local",
]


def _is_placeholder(val: str) -> bool:
    if not val:
        return True
    return any(p in val.lower() for p in ["your-project-id", "your-supabase", "example.com"])


def _read_env_key(key: str) -> Optional[str]:
    import os
    if key in os.environ and not _is_placeholder(os.environ[key]):
        return os.environ[key]
    for cand in _env_candidates:
        p = Path(cand)
        if p.is_file():
            try:
                for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
                    line = line.strip()
                    if line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip("'\"")
                    if k.upper() == key.upper() and not _is_placeholder(v):
                        return v
            except Exception:
                continue
    return None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_env_candidates,
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Supabase ──────────────────────────────────────────────────────────────
    supabase_url: str = ""
    next_public_supabase_url: str = ""
    supabase_service_role_key: str = ""

    @model_validator(mode="after")
    def resolve_supabase_fallbacks(self) -> "Settings":
        if _is_placeholder(self.supabase_url):
            if not _is_placeholder(self.next_public_supabase_url):
                self.supabase_url = self.next_public_supabase_url
            else:
                found_url = _read_env_key("SUPABASE_URL") or _read_env_key("NEXT_PUBLIC_SUPABASE_URL")
                if found_url:
                    self.supabase_url = found_url

        if _is_placeholder(self.supabase_service_role_key):
            found_key = _read_env_key("SUPABASE_SERVICE_ROLE_KEY")
            if found_key:
                self.supabase_service_role_key = found_key

        if not self.weather_api_key or _is_placeholder(self.weather_api_key):
            found_weather = _read_env_key("WEATHER_API_KEY")
            if found_weather:
                self.weather_api_key = found_weather

        if self.farm_latitude is None:
            lat_str = _read_env_key("FARM_LATITUDE")
            if lat_str:
                try:
                    self.farm_latitude = float(lat_str)
                except ValueError:
                    pass

        if self.farm_longitude is None:
            lon_str = _read_env_key("FARM_LONGITUDE")
            if lon_str:
                try:
                    self.farm_longitude = float(lon_str)
                except ValueError:
                    pass

        return self

    # ── Weather Provider (OpenWeatherMap) ─────────────────────────────────────
    weather_api_key: Optional[str] = None
    farm_latitude: Optional[float] = None
    farm_longitude: Optional[float] = None

    # ── Device ────────────────────────────────────────────────────────────────
    device_id: str = "FIELD_001"

    # ── Serial Port ───────────────────────────────────────────────────────────
    # "AUTO" → scan and auto-detect the ESP32.
    # "COM6" → use a specific port (override for difficult setups).
    serial_port: str = "AUTO"
    serial_baud: int = 115200

    # ── Mock Mode ─────────────────────────────────────────────────────────────
    # Set MOCK_SERIAL=true to generate fake sensor data without an ESP32.
    # MUST be false in production / Vercel.
    mock_serial: bool = False

    # ── Server ────────────────────────────────────────────────────────────────
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    # ── Logging ───────────────────────────────────────────────────────────────
    log_level: str = "INFO"

    # ── Anomaly thresholds (configurable, not hard-coded) ────────────────────
    # Threshold = how many units from baseline center triggers an event.
    threshold_soil_moisture: float = 8.0
    threshold_soil_temperature: float = 5.0
    threshold_air_temperature: float = 15.0
    threshold_humidity: float = 15.0
    threshold_light_lux: float = 50000.0

    @property
    def cors_origins_list(self) -> list[str]:
        origins = [o.strip() for o in self.cors_origins.split(",") if o.strip()]
        for default in ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:8000", "http://127.0.0.1:8000"]:
            if default not in origins:
                origins.append(default)
        return origins

    @property
    def supabase_configured(self) -> bool:
        if not (self.supabase_url and self.supabase_service_role_key):
            return False
        if "your-project-id" in self.supabase_url or "your-supabase" in self.supabase_service_role_key:
            return False
        return True

    @property
    def weather_configured(self) -> bool:
        if not self.weather_api_key:
            return False
        if _is_placeholder(self.weather_api_key):
            return False
        return True


# Singleton settings instance — import this everywhere
settings = Settings()

