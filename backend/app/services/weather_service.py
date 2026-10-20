# =============================================================================
# MARUDAM Backend — Asynchronous OpenWeatherMap Service
# =============================================================================
# Securely integrates OpenWeatherMap Current Weather (2.5) & 5-Day Forecast APIs.
# Never exposes the API key in logs, errors, or client responses.
# Strictly distinguishes measured ground sensors, current weather, and forecasts.
# =============================================================================
from __future__ import annotations

import asyncio
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple
import httpx
from pydantic import BaseModel, Field

from app.config import settings
from app.services import supabase_service
from app.utils.logger import get_logger

logger = get_logger("weather_service")

OWM_BASE_URL = "https://api.openweathermap.org/data/2.5"
OWM_GEO_URL = "https://api.openweathermap.org/geo/1.0/direct"

# In-memory TTL cache (5 minutes)
_weather_cache: Dict[str, Tuple[datetime, Any]] = {}
CACHE_TTL_SECONDS = 300


# ─── Custom Exceptions ────────────────────────────────────────────────────────

class WeatherServiceError(Exception):
    """Base exception for weather operations."""
    def __init__(self, message: str, status_code: int = 500, requires_config: bool = False):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.requires_config = requires_config


class WeatherLocationMissingError(WeatherServiceError):
    def __init__(self, message: str = "Farm location or coordinates are not configured. Please configure your farm location in Farm Profile Settings."):
        super().__init__(message, status_code=400, requires_config=True)


class WeatherLocationInvalidError(WeatherServiceError):
    def __init__(self, message: str = "Invalid coordinates. Latitude must be between -90 and 90, Longitude between -180 and 180."):
        super().__init__(message, status_code=422, requires_config=False)


class WeatherAuthError(WeatherServiceError):
    def __init__(self, message: str = "Weather provider authentication failed. Please check WEATHER_API_KEY."):
        super().__init__(message, status_code=502, requires_config=False)


class WeatherRateLimitError(WeatherServiceError):
    def __init__(self, message: str = "Weather provider rate limit reached. Please try again later."):
        super().__init__(message, status_code=429, requires_config=False)


class WeatherTimeoutError(WeatherServiceError):
    def __init__(self, message: str = "Weather service timed out. Please try again."):
        super().__init__(message, status_code=504, requires_config=False)


# ─── Pydantic Data Models ─────────────────────────────────────────────────────

class LocationMetadata(BaseModel):
    name: str
    district: Optional[str] = None
    state: Optional[str] = None
    country: str = "IN"
    latitude: float
    longitude: float


class CurrentWeatherData(BaseModel):
    timestamp: str
    condition: str
    description: str
    icon: str
    temperature: float = Field(..., description="Temperature in Celsius")
    feels_like: float = Field(..., description="Feels like in Celsius")
    temp_min: float
    temp_max: float
    humidity: float = Field(..., description="Relative humidity in %")
    pressure: float = Field(..., description="Atmospheric pressure in hPa")
    wind_speed: float = Field(..., description="Wind speed in m/s")
    wind_deg: Optional[int] = None
    clouds: int = Field(..., description="Cloudiness %")
    rain_1h: float = Field(0.0, description="Rain volume for last hour in mm")
    visibility: Optional[int] = None
    data_type: str = "CURRENT_METEOROLOGICAL"
    source: str = "OpenWeatherMap Meteorological Station"


class DailyForecastSummary(BaseModel):
    date: str
    temp_min: float
    temp_max: float
    humidity_avg: float
    rain_probability_max: float
    rain_volume_sum: float
    condition: str
    description: str
    icon: str
    data_type: str = "5_DAY_FORECAST"


class ForecastIntervalData(BaseModel):
    dt_txt: str
    temperature: float
    feels_like: float
    humidity: float
    condition: str
    description: str
    icon: str
    rain_probability: float
    rain_3h: float
    wind_speed: float


class ForecastData(BaseModel):
    location: LocationMetadata
    forecast_days: List[DailyForecastSummary]
    intervals: List[ForecastIntervalData]
    data_type: str = "FORECAST"
    source: str = "OpenWeatherMap 5-Day / 3-Hour Forecast"
    note: str = "Forecast is limited to 5 days ahead per provider availability. Beyond 5 days is not fabricated."


class HistoricalDayRecord(BaseModel):
    date: str
    soil_moisture_avg: Optional[float] = None
    soil_temperature_avg: Optional[float] = None
    air_temperature_avg: Optional[float] = None
    humidity_avg: Optional[float] = None
    readings_count: int = 0
    data_type: str = "MEASURED"
    source: str = "physical_esp32_sensor"


class AgriculturalReport15Day(BaseModel):
    device_id: str
    generated_at: str
    window_days: int = 15
    farm_context: Dict[str, Any]
    location: LocationMetadata
    
    # 1. Historical Ground Telemetry (Days -10 to -1)
    historical_ground_sensors: List[HistoricalDayRecord]
    
    # 2. Day 0 (Current)
    current_ground_sensor: Optional[Dict[str, Any]]
    current_weather_station: CurrentWeatherData
    
    # 3. Forecast Horizon (Days +1 to +5)
    forecast_outlook: List[DailyForecastSummary]
    
    # Distinctions and agronomic guidance
    data_lineage: Dict[str, str] = {
        "historical_ground_sensors": "PHYSICAL GROUND SENSORS (ESP32 measured root-zone & soil history from Supabase)",
        "current_ground_sensor": "PHYSICAL GROUND SENSORS (ESP32 live node telemetry)",
        "current_weather_station": "METEOROLOGICAL STATION (OpenWeatherMap real-time observations)",
        "forecast_outlook": "METEOROLOGICAL FORECAST (OpenWeatherMap 5-day / 3-hour projection)",
        "limitation_statement": "Historical weather is NOT fabricated. Forecasts are strictly limited to the provider 5-day available period."
    }
    agronomic_recommendation: Dict[str, Any]


# ─── Helper Functions ─────────────────────────────────────────────────────────

def validate_coordinates(lat: Optional[float], lon: Optional[float]) -> Tuple[float, float]:
    """Validates latitude and longitude ranges."""
    if lat is None or lon is None:
        raise WeatherLocationInvalidError("Both latitude and longitude must be provided.")
    if not (-90.0 <= lat <= 90.0):
        raise WeatherLocationInvalidError(f"Latitude {lat} is out of bounds (-90 to +90).")
    if not (-180.0 <= lon <= 180.0):
        raise WeatherLocationInvalidError(f"Longitude {lon} is out of bounds (-180 to +180).")
    return lat, lon


def _get_from_cache(cache_key: str) -> Optional[Any]:
    if cache_key in _weather_cache:
        cached_time, data = _weather_cache[cache_key]
        if (datetime.now(timezone.utc) - cached_time).total_seconds() < CACHE_TTL_SECONDS:
            return data
    return None


def _set_cache(cache_key: str, data: Any) -> None:
    _weather_cache[cache_key] = (datetime.now(timezone.utc), data)


async def _resolve_farm_location(
    device_id: Optional[str] = None,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    district: Optional[str] = None,
    state: Optional[str] = None,
) -> Tuple[Optional[float], Optional[float], Optional[str], Optional[str]]:
    """
    Resolves farm location following strict hierarchy:
    1. Explicit valid coordinates
    2. Explicit district/state
    3. Backend configured farm coordinates
    4. Supabase farm profile for device_id
    5. Returns None if completely unconfigured (NEVER silent fallback)
    """
    if lat is not None and lon is not None:
        validate_coordinates(lat, lon)
        return lat, lon, district, state

    if district and district.strip():
        return None, None, district.strip(), state.strip() if state else None

    # Check backend settings
    if settings.farm_latitude is not None and settings.farm_longitude is not None:
        validate_coordinates(settings.farm_latitude, settings.farm_longitude)
        return settings.farm_latitude, settings.farm_longitude, district, state

    # Check Supabase farm table if device_id provided
    target_dev = device_id or settings.device_id
    if target_dev:
        client = supabase_service.get_client()
        if client:
            try:
                res = client.table("farms").select("district, state").eq("device_id", target_dev).order("created_at", desc=True).limit(1).execute()
                if res.data and res.data[0].get("district"):
                    d = res.data[0]["district"].strip()
                    s = res.data[0].get("state", "").strip() or None
                    return None, None, d, s
            except Exception as e:
                logger.warning(f"Failed to lookup farm location for {target_dev}: {e}")

    return None, None, None, None


INDIAN_DISTRICT_ALIASES = {
    "tiruchirapalli": "Tiruchirappalli",
    "trichy": "Tiruchirappalli",
    "bengaluru urban": "Bengaluru",
    "bengaluru rural": "Bengaluru",
    "bangalore": "Bengaluru",
    "mysuru": "Mysore",
}

async def _geocode_district(district: str, state: Optional[str], api_key: str) -> Tuple[float, float, str]:
    """Geocodes Indian district/state using OpenWeatherMap direct geocoding."""
    normalized_district = INDIAN_DISTRICT_ALIASES.get(district.strip().lower(), district.strip())
    cache_key = f"geo_{normalized_district.lower()}_{str(state).lower() if state else ''}"
    cached = _get_from_cache(cache_key)
    if cached:
        return cached

    query = f"{normalized_district},{state},IN" if state else f"{normalized_district},IN"
    params = {"q": query, "limit": 1, "appid": api_key}
    
    async with httpx.AsyncClient(timeout=8.0) as client:
        try:
            resp = await client.get(OWM_GEO_URL, params=params)
            if resp.status_code == 401:
                raise WeatherAuthError()
            if resp.status_code == 429:
                raise WeatherRateLimitError()
            resp.raise_for_status()
            results = resp.json()
            if results and len(results) > 0:
                first = results[0]
                resolved = (float(first["lat"]), float(first["lon"]), first.get("name", district))
                _set_cache(cache_key, resolved)
                return resolved
        except httpx.TimeoutException:
            raise WeatherTimeoutError()
        except WeatherServiceError:
            raise
        except Exception as e:
            logger.warning(f"Geocoding failed for {query}: {e}")

    # Fallback to district-only query
    if state:
        return await _geocode_district(district, None, api_key)
    raise WeatherLocationMissingError(f"Could not resolve geographical coordinates for district '{district}'. Please verify your farm location in Settings.")


# ─── Public Service Methods ───────────────────────────────────────────────────

async def get_current_weather(
    device_id: Optional[str] = None,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    district: Optional[str] = None,
    state: Optional[str] = None,
) -> Dict[str, Any]:
    """Retrieves current weather from OpenWeatherMap 2.5/weather."""
    if not settings.weather_configured:
        raise WeatherServiceError("WEATHER_API_KEY is not configured in backend/.env.", status_code=503)

    api_key = settings.weather_api_key

    resolved_lat, resolved_lon, resolved_dist, resolved_state = await _resolve_farm_location(
        device_id=device_id, lat=lat, lon=lon, district=district, state=state
    )

    if resolved_lat is None and resolved_lon is None and not resolved_dist:
        raise WeatherLocationMissingError()

    if resolved_lat is None or resolved_lon is None:
        resolved_lat, resolved_lon, loc_name = await _geocode_district(resolved_dist, resolved_state, api_key)
    else:
        loc_name = resolved_dist or "Farm Location"

    cache_key = f"current_{resolved_lat:.3f}_{resolved_lon:.3f}"
    cached = _get_from_cache(cache_key)
    if cached:
        return cached

    params = {
        "lat": resolved_lat,
        "lon": resolved_lon,
        "units": "metric",
        "appid": api_key,
    }

    async with httpx.AsyncClient(timeout=8.0) as client:
        try:
            resp = await client.get(f"{OWM_BASE_URL}/weather", params=params)
            if resp.status_code == 401:
                raise WeatherAuthError()
            if resp.status_code == 429:
                raise WeatherRateLimitError()
            resp.raise_for_status()
            raw = resp.json()
        except httpx.TimeoutException:
            raise WeatherTimeoutError()
        except WeatherServiceError:
            raise
        except Exception as e:
            logger.error(f"Error fetching current weather: {e}")
            raise WeatherServiceError(f"Failed to fetch weather: {str(e)}")

    weather_desc = raw.get("weather", [{}])[0]
    main = raw.get("main", {})
    wind = raw.get("wind", {})
    rain = raw.get("rain", {})

    loc_meta = LocationMetadata(
        name=raw.get("name") or loc_name,
        district=resolved_dist or raw.get("name"),
        state=resolved_state,
        country=raw.get("sys", {}).get("country", "IN"),
        latitude=resolved_lat,
        longitude=resolved_lon,
    )

    current_data = CurrentWeatherData(
        timestamp=datetime.now(timezone.utc).isoformat(),
        condition=weather_desc.get("main", "Unknown"),
        description=weather_desc.get("description", "Unknown").capitalize(),
        icon=weather_desc.get("icon", "01d"),
        temperature=round(float(main.get("temp", 0.0)), 1),
        feels_like=round(float(main.get("feels_like", 0.0)), 1),
        temp_min=round(float(main.get("temp_min", 0.0)), 1),
        temp_max=round(float(main.get("temp_max", 0.0)), 1),
        humidity=float(main.get("humidity", 0)),
        pressure=float(main.get("pressure", 1013)),
        wind_speed=round(float(wind.get("speed", 0.0)), 1),
        wind_deg=wind.get("deg"),
        clouds=int(raw.get("clouds", {}).get("all", 0)),
        rain_1h=float(rain.get("1h", 0.0)),
        visibility=raw.get("visibility"),
    )

    result = {
        "status": "ok",
        "location": loc_meta.model_dump(),
        "current": current_data.model_dump(),
    }
    _set_cache(cache_key, result)
    return result


async def get_forecast(
    device_id: Optional[str] = None,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    district: Optional[str] = None,
    state: Optional[str] = None,
) -> Dict[str, Any]:
    """Retrieves 5-day / 3-hour forecast from OpenWeatherMap 2.5/forecast."""
    if not settings.weather_configured:
        raise WeatherServiceError("WEATHER_API_KEY is not configured in backend/.env.", status_code=503)

    api_key = settings.weather_api_key

    resolved_lat, resolved_lon, resolved_dist, resolved_state = await _resolve_farm_location(
        device_id=device_id, lat=lat, lon=lon, district=district, state=state
    )

    if resolved_lat is None and resolved_lon is None and not resolved_dist:
        raise WeatherLocationMissingError()

    if resolved_lat is None or resolved_lon is None:
        resolved_lat, resolved_lon, loc_name = await _geocode_district(resolved_dist, resolved_state, api_key)
    else:
        loc_name = resolved_dist or "Farm Location"

    cache_key = f"forecast_{resolved_lat:.3f}_{resolved_lon:.3f}"
    cached = _get_from_cache(cache_key)
    if cached:
        return cached

    params = {
        "lat": resolved_lat,
        "lon": resolved_lon,
        "units": "metric",
        "appid": api_key,
    }

    async with httpx.AsyncClient(timeout=8.0) as client:
        try:
            resp = await client.get(f"{OWM_BASE_URL}/forecast", params=params)
            if resp.status_code == 401:
                raise WeatherAuthError()
            if resp.status_code == 429:
                raise WeatherRateLimitError()
            resp.raise_for_status()
            raw = resp.json()
        except httpx.TimeoutException:
            raise WeatherTimeoutError()
        except WeatherServiceError:
            raise
        except Exception as e:
            logger.error(f"Error fetching forecast: {e}")
            raise WeatherServiceError(f"Failed to fetch forecast: {str(e)}")

    raw_list = raw.get("list", [])
    city = raw.get("city", {})

    loc_meta = LocationMetadata(
        name=city.get("name") or loc_name,
        district=resolved_dist or city.get("name"),
        state=resolved_state,
        country=city.get("country", "IN"),
        latitude=resolved_lat,
        longitude=resolved_lon,
    )

    intervals: List[ForecastIntervalData] = []
    daily_groups: Dict[str, List[dict]] = {}

    for item in raw_list:
        dt_txt = item.get("dt_txt", "")
        date_str = dt_txt.split(" ")[0] if " " in dt_txt else dt_txt[:10]
        main = item.get("main", {})
        weather_desc = item.get("weather", [{}])[0]
        pop = float(item.get("pop", 0.0)) * 100.0  # probability of precipitation %
        rain_3h = float(item.get("rain", {}).get("3h", 0.0))
        wind = item.get("wind", {})

        interval_entry = ForecastIntervalData(
            dt_txt=dt_txt,
            temperature=round(float(main.get("temp", 0.0)), 1),
            feels_like=round(float(main.get("feels_like", 0.0)), 1),
            humidity=float(main.get("humidity", 0)),
            condition=weather_desc.get("main", "Unknown"),
            description=weather_desc.get("description", "Unknown").capitalize(),
            icon=weather_desc.get("icon", "01d"),
            rain_probability=round(pop, 1),
            rain_3h=round(rain_3h, 2),
            wind_speed=round(float(wind.get("speed", 0.0)), 1),
        )
        intervals.append(interval_entry)

        if date_str not in daily_groups:
            daily_groups[date_str] = []
        daily_groups[date_str].append({
            "temp": interval_entry.temperature,
            "humidity": interval_entry.humidity,
            "pop": interval_entry.rain_probability,
            "rain": interval_entry.rain_3h,
            "condition": interval_entry.condition,
            "description": interval_entry.description,
            "icon": interval_entry.icon,
        })

    forecast_days: List[DailyForecastSummary] = []
    # Up to 5 consecutive forecast days
    for date_key in sorted(daily_groups.keys())[:5]:
        entries = daily_groups[date_key]
        temps = [e["temp"] for e in entries]
        humidities = [e["humidity"] for e in entries]
        pops = [e["pop"] for e in entries]
        rains = [e["rain"] for e in entries]
        
        # Pick mid-day condition or first available
        mid_idx = len(entries) // 2
        rep = entries[mid_idx]

        forecast_days.append(DailyForecastSummary(
            date=date_key,
            temp_min=min(temps),
            temp_max=max(temps),
            humidity_avg=round(sum(humidities) / len(humidities), 1),
            rain_probability_max=round(max(pops), 1),
            rain_volume_sum=round(sum(rains), 2),
            condition=rep["condition"],
            description=rep["description"],
            icon=rep["icon"],
        ))

    forecast_result = ForecastData(
        location=loc_meta,
        forecast_days=forecast_days,
        intervals=intervals,
    )

    result = {
        "status": "ok",
        **forecast_result.model_dump(),
    }
    _set_cache(cache_key, result)
    return result


async def get_15_day_agricultural_report(
    device_id: str,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    district: Optional[str] = None,
    state: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Synthesizes the 15-day agricultural report:
    - Days -10 to -1: Historical physical ground sensor logs from Supabase
    - Day 0: Current ground telemetry + Current OpenWeatherMap weather
    - Days +1 to +5: 5-Day forward weather forecast (strictly bounded to provider horizon)
    """
    # 1. Fetch current weather and 5-day forecast concurrently
    current_res, forecast_res = await asyncio.gather(
        get_current_weather(device_id=device_id, lat=lat, lon=lon, district=district, state=state),
        get_forecast(device_id=device_id, lat=lat, lon=lon, district=district, state=state),
    )

    location_info = current_res["location"]
    current_weather = CurrentWeatherData(**current_res["current"])
    forecast_days = [DailyForecastSummary(**f) for f in forecast_res["forecast_days"]]

    # 2. Retrieve Farm Context from Supabase
    client = supabase_service.get_client()
    farm_info: Dict[str, Any] = {
        "device_id": device_id,
        "crop_id": "brinjal",
        "district": location_info.get("district") or location_info.get("name"),
        "state": location_info.get("state"),
    }
    if client:
        try:
            f_res = client.table("farms").select("*").eq("device_id", device_id).order("created_at", desc=True).limit(1).execute()
            if f_res.data:
                farm_info.update(f_res.data[0])
        except Exception as e:
            logger.warning(f"Failed to load farm info for report: {e}")

    # 3. Retrieve Historical Ground Sensor Readings (up to past 10 days)
    now_utc = datetime.now(timezone.utc)
    ten_days_ago = (now_utc - timedelta(days=10)).isoformat()
    historical_records: List[HistoricalDayRecord] = []

    if client:
        try:
            readings_res = client.table("sensor_readings") \
                .select("timestamp, soil_moisture, soil_temperature, air_temperature, humidity") \
                .eq("device_id", device_id) \
                .gte("timestamp", ten_days_ago) \
                .order("timestamp", desc=False) \
                .execute()
            
            raw_data = readings_res.data or []
            daily_sensor_groups: Dict[str, List[dict]] = {}
            for r in raw_data:
                ts = r.get("timestamp")
                if not ts:
                    continue
                d_key = ts[:10]
                if d_key not in daily_sensor_groups:
                    daily_sensor_groups[d_key] = []
                daily_sensor_groups[d_key].append(r)

            for d_str, records in sorted(daily_sensor_groups.items()):
                moistures = [r["soil_moisture"] for r in records if r.get("soil_moisture") is not None]
                soil_temps = [r["soil_temperature"] for r in records if r.get("soil_temperature") is not None]
                air_temps = [r["air_temperature"] for r in records if r.get("air_temperature") is not None]
                humidities = [r["humidity"] for r in records if r.get("humidity") is not None]

                historical_records.append(HistoricalDayRecord(
                    date=d_str,
                    soil_moisture_avg=round(sum(moistures) / len(moistures), 1) if moistures else None,
                    soil_temperature_avg=round(sum(soil_temps) / len(soil_temps), 1) if soil_temps else None,
                    air_temperature_avg=round(sum(air_temps) / len(air_temps), 1) if air_temps else None,
                    humidity_avg=round(sum(humidities) / len(humidities), 1) if humidities else None,
                    readings_count=len(records),
                ))
        except Exception as e:
            logger.warning(f"Error querying historical sensor readings for report: {e}")

    # 4. Get Current Ground Sensor Reading
    latest_reading = None
    try:
        latest_reading = supabase_service.get_latest_reading(device_id)
    except Exception as e:
        logger.warning(f"Failed to fetch latest ground reading: {e}")

    # 5. Agronomic Synthesis
    # Synthesize soil moisture deficit vs forecast rain
    latest_sm = latest_reading.get("soil_moisture") if latest_reading else None
    forecast_rain_days = [f for f in forecast_days if f.rain_probability_max >= 50.0]
    total_forecast_rain_mm = sum(f.rain_volume_sum for f in forecast_days)
    sm_str = f"{latest_sm:.1f}%" if latest_sm is not None else "unknown"

    if latest_sm is not None and latest_sm < 30.0:
        if forecast_rain_days:
            next_rain_day = forecast_rain_days[0]
            recommendation = (
                f"Soil moisture is low ({latest_sm:.1f}%), but significant rainfall is forecasted "
                f"for {next_rain_day.date} (Rain chance: {next_rain_day.rain_probability_max:.0f}%, {next_rain_day.rain_volume_sum:.1f}mm). "
                f"Delay heavy irrigation and monitor field conditions."
            )
            action_code = "DELAY_IRRIGATION_RAIN_EXPECTED"
        else:
            recommendation = (
                f"Soil moisture is low ({latest_sm:.1f}%) and dry weather with negligible rain ({total_forecast_rain_mm:.1f}mm) "
                f"is forecasted over the next 5 days. Consider scheduled irrigation."
            )
            action_code = "CONSIDER_IRRIGATION"
    elif latest_sm is not None and latest_sm > 70.0:
        recommendation = (
            f"Soil moisture is high ({latest_sm:.1f}%). Ensure adequate drainage, especially with "
            f"{total_forecast_rain_mm:.1f}mm rainfall projected in the next 5 days."
        )
        action_code = "DRAINAGE_CAUTION"
    else:
        recommendation = (
            f"Ground soil moisture is within normal range ({sm_str}). "
            f"Projected rainfall for next 5 days: {total_forecast_rain_mm:.1f}mm. Continue routine field monitoring."
        )
        action_code = "ROUTINE_MONITORING"

    report = AgriculturalReport15Day(
        device_id=device_id,
        generated_at=now_utc.isoformat(),
        window_days=15,
        farm_context=farm_info,
        location=LocationMetadata(**location_info),
        historical_ground_sensors=historical_records,
        current_ground_sensor=latest_reading,
        current_weather_station=current_weather,
        forecast_outlook=forecast_days,
        agronomic_recommendation={
            "action_code": action_code,
            "text": recommendation,
            "total_5day_forecast_rain_mm": total_forecast_rain_mm,
            "forecast_rainy_days_count": len(forecast_rain_days),
        }
    )

    return {
        "status": "ok",
        **report.model_dump(),
    }


async def get_weather_observations_for_baseline(
    district: str,
    state: Optional[str] = None
) -> Optional[List[Dict[str, Any]]]:
    """
    Extracts recent and forecast weather slices suitable for adaptive baseline calculation.
    Returns observations with air_temperature, humidity, etc.
    """
    try:
        forecast_res = await get_forecast(district=district, state=state)
        intervals = forecast_res.get("intervals", [])
        if not intervals:
            return None

        observations = []
        for item in intervals[:16]:  # Next 48 hours (16 slices of 3h)
            observations.append({
                "timestamp": item.get("dt_txt"),
                "air_temperature": item.get("temperature"),
                "humidity": item.get("humidity"),
                "rain_probability": item.get("rain_probability"),
                "wind_speed": item.get("wind_speed"),
            })
        return observations if len(observations) >= 2 else None
    except Exception as e:
        logger.warning(f"Could not load weather observations for adaptive baseline: {e}")
        return None
