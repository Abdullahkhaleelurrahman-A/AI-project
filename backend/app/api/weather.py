# =============================================================================
# MARUDAM Backend — Weather API Router
# =============================================================================
from __future__ import annotations

from typing import Optional
from fastapi import APIRouter, HTTPException, Query, status

from app.services import weather_service
from app.services.weather_service import (
    WeatherServiceError,
    WeatherLocationMissingError,
    WeatherLocationInvalidError,
    WeatherAuthError,
    WeatherRateLimitError,
    WeatherTimeoutError,
)

router = APIRouter(prefix="/api/weather", tags=["weather"])


def _handle_weather_exception(e: Exception) -> HTTPException:
    if isinstance(e, WeatherLocationInvalidError):
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": e.message, "type": "INVALID_COORDINATES", "requires_configuration": False}
        )
    if isinstance(e, WeatherLocationMissingError):
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": e.message, "type": "LOCATION_MISSING", "requires_configuration": True}
        )
    if isinstance(e, WeatherAuthError):
        return HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"error": e.message, "type": "PROVIDER_AUTH_ERROR", "requires_configuration": False}
        )
    if isinstance(e, WeatherRateLimitError):
        return HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"error": e.message, "type": "RATE_LIMIT_EXCEEDED", "requires_configuration": False}
        )
    if isinstance(e, WeatherTimeoutError):
        return HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail={"error": e.message, "type": "GATEWAY_TIMEOUT", "requires_configuration": False}
        )
    if isinstance(e, WeatherServiceError):
        return HTTPException(
            status_code=e.status_code,
            detail={"error": e.message, "type": "WEATHER_SERVICE_ERROR", "requires_configuration": e.requires_config}
        )
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail={"error": "An unexpected error occurred while retrieving weather data.", "type": "INTERNAL_ERROR"}
    )


@router.get("/current")
async def get_current_weather(
    device_id: Optional[str] = Query(None, description="ESP32 Device ID to resolve farm profile"),
    lat: Optional[float] = Query(None, description="Farm Latitude (-90 to 90)"),
    lon: Optional[float] = Query(None, description="Farm Longitude (-180 to 180)"),
    district: Optional[str] = Query(None, description="District name in India"),
    state: Optional[str] = Query(None, description="State name in India"),
):
    """
    Retrieves real-time current weather from OpenWeatherMap for the specified farm location.
    Validates coordinates and handles timeouts, rate limits, and authentication errors securely.
    """
    try:
        if lat is not None or lon is not None:
            weather_service.validate_coordinates(lat, lon)
        return await weather_service.get_current_weather(
            device_id=device_id, lat=lat, lon=lon, district=district, state=state
        )
    except Exception as e:
        raise _handle_weather_exception(e)


@router.get("/forecast")
async def get_forecast(
    device_id: Optional[str] = Query(None, description="ESP32 Device ID to resolve farm profile"),
    lat: Optional[float] = Query(None, description="Farm Latitude (-90 to 90)"),
    lon: Optional[float] = Query(None, description="Farm Longitude (-180 to 180)"),
    district: Optional[str] = Query(None, description="District name in India"),
    state: Optional[str] = Query(None, description="State name in India"),
):
    """
    Retrieves 5-day / 3-hour forecast from OpenWeatherMap with daily aggregates.
    Strictly limited to the provider's 5-day period (does not invent predictions beyond 5 days).
    """
    try:
        if lat is not None or lon is not None:
            weather_service.validate_coordinates(lat, lon)
        return await weather_service.get_forecast(
            device_id=device_id, lat=lat, lon=lon, district=district, state=state
        )
    except Exception as e:
        raise _handle_weather_exception(e)


@router.get("/report/15-day/{device_id}")
async def get_15_day_agricultural_report(
    device_id: str,
    lat: Optional[float] = Query(None, description="Farm Latitude (-90 to 90)"),
    lon: Optional[float] = Query(None, description="Farm Longitude (-180 to 180)"),
    district: Optional[str] = Query(None, description="District name in India"),
    state: Optional[str] = Query(None, description="State name in India"),
):
    """
    Generates a unified 15-day agricultural telemetry and forecast report:
    - Days -10 to -1: Historical physical ground sensor records (ESP32 measured in Supabase)
    - Day 0: Current physical sensor readings + Current weather station observations
    - Days +1 to +5: 5-Day forward weather forecast (strictly bounded to provider horizon)
    - Clearly distinguishes measured ground telemetry from meteorological observations and predictions.
    """
    try:
        if lat is not None or lon is not None:
            weather_service.validate_coordinates(lat, lon)
        return await weather_service.get_15_day_agricultural_report(
            device_id=device_id, lat=lat, lon=lon, district=district, state=state
        )
    except Exception as e:
        raise _handle_weather_exception(e)
