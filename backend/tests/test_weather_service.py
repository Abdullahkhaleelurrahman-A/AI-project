# =============================================================================
# MARUDAM Backend — Weather Service & API Tests
# =============================================================================
import pytest
from unittest.mock import patch, MagicMock, AsyncMock
import httpx
from fastapi.testclient import TestClient

from app.main import app
from app.config import settings
from app.services import weather_service
from app.services.weather_service import (
    validate_coordinates,
    WeatherLocationInvalidError,
    WeatherLocationMissingError,
    WeatherAuthError,
    WeatherRateLimitError,
    WeatherTimeoutError,
)

client = TestClient(app)

MOCK_CURRENT_OWM_RESPONSE = {
    "coord": {"lon": 79.131, "lat": 12.907},
    "weather": [{"id": 803, "main": "Clouds", "description": "broken clouds", "icon": "04d"}],
    "main": {
        "temp": 28.5,
        "feels_like": 31.2,
        "temp_min": 27.0,
        "temp_max": 29.5,
        "pressure": 1011,
        "humidity": 78
    },
    "visibility": 10000,
    "wind": {"speed": 4.1, "deg": 90},
    "clouds": {"all": 75},
    "rain": {"1h": 0.5},
    "sys": {"country": "IN"},
    "name": "Vellore"
}

MOCK_FORECAST_OWM_RESPONSE = {
    "city": {"name": "Vellore", "country": "IN", "coord": {"lat": 12.907, "lon": 79.131}},
    "list": [
        {
            "dt_txt": "2026-10-20 06:00:00",
            "main": {"temp": 28.5, "feels_like": 31.0, "humidity": 75},
            "weather": [{"main": "Clouds", "description": "scattered clouds", "icon": "03d"}],
            "pop": 0.2,
            "rain": {"3h": 0.0},
            "wind": {"speed": 3.5}
        },
        {
            "dt_txt": "2026-10-20 12:00:00",
            "main": {"temp": 32.0, "feels_like": 36.0, "humidity": 65},
            "weather": [{"main": "Rain", "description": "light rain", "icon": "10d"}],
            "pop": 0.65,
            "rain": {"3h": 2.5},
            "wind": {"speed": 4.0}
        },
        {
            "dt_txt": "2026-10-21 06:00:00",
            "main": {"temp": 27.0, "feels_like": 29.0, "humidity": 80},
            "weather": [{"main": "Clear", "description": "clear sky", "icon": "01d"}],
            "pop": 0.1,
            "rain": {"3h": 0.0},
            "wind": {"speed": 2.5}
        },
        {
            "dt_txt": "2026-10-22 06:00:00",
            "main": {"temp": 26.5, "feels_like": 28.5, "humidity": 82},
            "weather": [{"main": "Rain", "description": "moderate rain", "icon": "10d"}],
            "pop": 0.85,
            "rain": {"3h": 8.0},
            "wind": {"speed": 5.0}
        },
        {
            "dt_txt": "2026-10-23 06:00:00",
            "main": {"temp": 29.0, "feels_like": 31.5, "humidity": 70},
            "weather": [{"main": "Clouds", "description": "few clouds", "icon": "02d"}],
            "pop": 0.15,
            "rain": {"3h": 0.0},
            "wind": {"speed": 3.0}
        },
        {
            "dt_txt": "2026-10-24 06:00:00",
            "main": {"temp": 30.0, "feels_like": 33.0, "humidity": 68},
            "weather": [{"main": "Clear", "description": "clear sky", "icon": "01d"}],
            "pop": 0.05,
            "rain": {"3h": 0.0},
            "wind": {"speed": 2.8}
        }
    ]
}


@pytest.fixture(autouse=True)
def setup_weather_test_env():
    orig_key = settings.weather_api_key
    settings.weather_api_key = "test_owm_key_1234567890abcdef12"
    weather_service._weather_cache.clear()
    yield
    settings.weather_api_key = orig_key
    weather_service._weather_cache.clear()


# ─── Unit Tests: Coordinate Validation ────────────────────────────────────────

def test_validate_coordinates_valid():
    lat, lon = validate_coordinates(12.907, 79.131)
    assert lat == 12.907
    assert lon == 79.131


def test_validate_coordinates_out_of_bounds():
    with pytest.raises(WeatherLocationInvalidError) as excinfo:
        validate_coordinates(95.0, 79.131)
    assert "Latitude 95.0 is out of bounds" in str(excinfo.value)

    with pytest.raises(WeatherLocationInvalidError) as excinfo:
        validate_coordinates(12.907, -190.0)
    assert "Longitude -190.0 is out of bounds" in str(excinfo.value)


def test_validate_coordinates_none():
    with pytest.raises(WeatherLocationInvalidError):
        validate_coordinates(None, 79.131)
    with pytest.raises(WeatherLocationInvalidError):
        validate_coordinates(12.907, None)


# ─── Unit Tests: Missing Location Hierarchy ───────────────────────────────────

@pytest.mark.asyncio
async def test_weather_missing_location_raises_clean_error():
    """If no coordinates, district, or farm profile are found, do NOT silently fallback."""
    with patch("app.services.weather_service._resolve_farm_location", return_value=(None, None, None, None)):
        with pytest.raises(WeatherLocationMissingError) as excinfo:
            await weather_service.get_current_weather(device_id="UNCONFIGURED_DEV")
        assert excinfo.value.requires_config is True
        assert "Farm location or coordinates are not configured" in str(excinfo.value)


# ─── Unit Tests: Current Weather Parsing ──────────────────────────────────────

@pytest.mark.asyncio
async def test_get_current_weather_parsing():
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = MOCK_CURRENT_OWM_RESPONSE
    mock_resp.raise_for_status.return_value = None

    with patch("httpx.AsyncClient.get", return_value=mock_resp):
        res = await weather_service.get_current_weather(lat=12.907, lon=79.131)
        
        assert res["status"] == "ok"
        current = res["current"]
        assert current["temperature"] == 28.5
        assert current["feels_like"] == 31.2
        assert current["humidity"] == 78
        assert current["condition"] == "Clouds"
        assert current["rain_1h"] == 0.5
        assert current["data_type"] == "CURRENT_METEOROLOGICAL"
        assert "OpenWeatherMap" in current["source"]
        
        # Verify API key is NOT exposed in the output
        res_str = str(res)
        if settings.weather_api_key:
            assert settings.weather_api_key not in res_str


# ─── Unit Tests: 5-Day Forecast Aggregation ───────────────────────────────────

@pytest.mark.asyncio
async def test_get_forecast_parsing_and_aggregation():
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = MOCK_FORECAST_OWM_RESPONSE
    mock_resp.raise_for_status.return_value = None

    with patch("httpx.AsyncClient.get", return_value=mock_resp):
        res = await weather_service.get_forecast(lat=12.907, lon=79.131)
        
        assert res["status"] == "ok"
        forecast_days = res["forecast_days"]
        assert len(forecast_days) <= 5
        
        day_1 = forecast_days[0]
        assert day_1["date"] == "2026-10-20"
        # Verify rain probability max on Day 1 is 65% (0.65 * 100)
        assert day_1["rain_probability_max"] == 65.0
        assert day_1["rain_volume_sum"] == 2.5
        
        assert "not fabricated" in res["note"]


# ─── Unit Tests: 15-Day Agricultural Report ───────────────────────────────────

@pytest.mark.asyncio
async def test_15_day_agricultural_report_synthesis():
    mock_curr = {
        "status": "ok",
        "location": {"name": "Vellore", "district": "Vellore", "state": "Tamil Nadu", "country": "IN", "latitude": 12.907, "longitude": 79.131},
        "current": {
            "timestamp": "2026-10-20T06:00:00Z", "condition": "Clouds", "description": "Overcast", "icon": "04d",
            "temperature": 28.0, "feels_like": 30.0, "temp_min": 26.0, "temp_max": 29.0,
            "humidity": 75, "pressure": 1012, "wind_speed": 3.5, "wind_deg": 90, "clouds": 80, "rain_1h": 0.0,
            "data_type": "CURRENT_METEOROLOGICAL", "source": "OpenWeatherMap"
        }
    }
    mock_fc = {
        "status": "ok",
        "location": mock_curr["location"],
        "forecast_days": [
            {
                "date": "2026-10-21", "temp_min": 25.0, "temp_max": 31.0, "humidity_avg": 70,
                "rain_probability_max": 80.0, "rain_volume_sum": 12.0, "condition": "Rain",
                "description": "heavy rain", "icon": "10d", "data_type": "5_DAY_FORECAST"
            }
        ],
        "intervals": []
    }

    with patch("app.services.weather_service.get_current_weather", return_value=mock_curr), \
         patch("app.services.weather_service.get_forecast", return_value=mock_fc), \
         patch("app.services.supabase_service.get_latest_reading", return_value={"soil_moisture": 25.0, "soil_temperature": 27.5}):
        
        rep = await weather_service.get_15_day_agricultural_report(device_id="FIELD_001")
        
        assert rep["status"] == "ok"
        assert rep["window_days"] == 15
        assert rep["current_weather_station"]["data_type"] == "CURRENT_METEOROLOGICAL"
        assert rep["current_ground_sensor"]["soil_moisture"] == 25.0
        
        # In moisture deficit + heavy rain forecast -> should recommend delay irrigation
        rec = rep["agronomic_recommendation"]
        assert rec["action_code"] == "DELAY_IRRIGATION_RAIN_EXPECTED"
        assert "Delay heavy irrigation" in rec["text"]
        
        # Verify strict lineage note
        assert "Historical weather is NOT fabricated" in rep["data_lineage"]["limitation_statement"]


# ─── Unit Tests: Error Handling (401, 429, Timeout) ───────────────────────────

@pytest.mark.asyncio
async def test_weather_error_handling():
    # 1. 401 Unauthorized
    resp_401 = MagicMock(status_code=401)
    with patch("httpx.AsyncClient.get", return_value=resp_401):
        with pytest.raises(WeatherAuthError):
            await weather_service.get_current_weather(lat=12.907, lon=79.131)

    # 2. 429 Rate Limit
    resp_429 = MagicMock(status_code=429)
    with patch("httpx.AsyncClient.get", return_value=resp_429):
        with pytest.raises(WeatherRateLimitError):
            await weather_service.get_current_weather(lat=12.907, lon=79.131)

    # 3. Timeout
    with patch("httpx.AsyncClient.get", side_effect=httpx.TimeoutException("Read timed out")):
        with pytest.raises(WeatherTimeoutError):
            await weather_service.get_current_weather(lat=12.907, lon=79.131)


# ─── Integration Tests: FastAPI Endpoints ─────────────────────────────────────

def test_api_weather_current_success():
    with patch("app.services.weather_service.get_current_weather") as mock_get:
        mock_get.return_value = {
            "status": "ok",
            "location": {"name": "Vellore", "latitude": 12.907, "longitude": 79.131},
            "current": {"temperature": 28.5, "condition": "Clouds", "humidity": 75}
        }
        res = client.get("/api/weather/current?lat=12.907&lon=79.131")
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ok"
        assert data["current"]["temperature"] == 28.5


def test_api_weather_invalid_coordinates():
    res = client.get("/api/weather/current?lat=195.0&lon=79.131")
    assert res.status_code == 422
    data = res.json()
    assert data["detail"]["type"] == "INVALID_COORDINATES"


def test_api_weather_missing_location():
    with patch("app.services.weather_service.get_current_weather", side_effect=WeatherLocationMissingError()):
        res = client.get("/api/weather/current")
        assert res.status_code == 400
        data = res.json()
        assert data["detail"]["requires_configuration"] is True


def test_api_weather_report_15_day_endpoint():
    with patch("app.services.weather_service.get_15_day_agricultural_report") as mock_rep:
        mock_rep.return_value = {
            "status": "ok",
            "device_id": "FIELD_001",
            "window_days": 15,
            "agronomic_recommendation": {"action_code": "ROUTINE_MONITORING"}
        }
        res = client.get("/api/weather/report/15-day/FIELD_001")
        assert res.status_code == 200
        data = res.json()
        assert data["device_id"] == "FIELD_001"
        assert data["window_days"] == 15
