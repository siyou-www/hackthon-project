"""Shared forecasts and activity advice, without importing the FastAPI app or task DB."""
import logging
import math

import httpx
from fastapi import HTTPException
from comfort import get_comfort

logger = logging.getLogger(__name__)


def _log_httpx_failure(error):
    # Never include exception text, traceback, URLs, headers, or response bodies.
    status = getattr(getattr(error, "response", None), "status_code", None)
    logger.warning("Open-Meteo request failed: exception=%s upstream_status=%s",
                   type(error).__name__, status)


async def fetch_weather(latitude: float, longitude: float, forecast_timezone: str = "auto"):
    """Fetch and validate the hourly forecast shared by both weather endpoints."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": latitude,
                    "longitude": longitude,
                    "hourly": "temperature_2m,precipitation_probability",
                    "temperature_unit": "celsius",
                    "timezone": forecast_timezone,
                },
            )
            response.raise_for_status()
    except httpx.TimeoutException as error:
        _log_httpx_failure(error)
        raise HTTPException(504, "Weather service timed out. Please try again.") from None
    except httpx.HTTPError as error:
        _log_httpx_failure(error)
        raise HTTPException(502, "Weather service is unavailable. Please try again.") from None

    try:
        data = response.json()
        timezone = data["timezone"]
        hourly = data["hourly"]
        times = hourly["time"]
        temperatures = hourly["temperature_2m"]
        probabilities = hourly["precipitation_probability"]
        if not isinstance(timezone, str) or not timezone.strip():
            raise ValueError
        if not all(isinstance(values, list) for values in (times, temperatures, probabilities)):
            raise ValueError
        if not times or not len(times) == len(temperatures) == len(probabilities):
            raise ValueError

        forecast = []
        for time, temperature, probability in zip(times, temperatures, probabilities):
            if not isinstance(time, str) or not time.strip():
                raise ValueError
            if any(
                type(value) not in (int, float) or not math.isfinite(value)
                for value in (temperature, probability)
            ) or not 0 <= probability <= 100:
                raise ValueError
            forecast.append({
                "time": time,
                "temperature_c": temperature,
                "temperature_f": temperature * 9 / 5 + 32,
                "precipitation_probability": probability,
            })
        return {"timezone": timezone, "hourly": forecast}
    except (ValueError, KeyError, TypeError):
        raise HTTPException(502, "Weather service returned incomplete or invalid forecast data.") from None



def activity_advice(activity, weather: dict):
    advice = []
    if activity.outdoor:
        # Put rain warnings first because they may change an outdoor plan.
        if weather["precipitation_probability"] >= 60:
            advice.append("Bring an umbrella or consider an indoor alternative.")
        if weather["temperature_c"] >= 30:
            advice.append("Stay hydrated and use sun protection.")
        elif weather["temperature_c"] <= 10:
            advice.append("Bring an extra layer to stay warm.")
    else:
        if weather["precipitation_probability"] >= 60:
            advice.append("Bring an umbrella for your trip to this indoor activity.")
        if weather["temperature_c"] >= 30:
            advice.append("Stay hydrated and use sun protection when traveling outside.")
        elif weather["temperature_c"] <= 10:
            advice.append("Bring an extra layer for your trip outside.")
    if not advice:
        advice.append("No major temperature or rain concerns for this hour.")
    return advice


def activity_result(activity, weather: dict, preference: str):
    comfort = get_comfort(weather["temperature_c"], preference, activity.outdoor)
    return {
        "activity": activity.model_dump(),
        "weather": weather,
        "advice": activity_advice(activity, weather),
        "comfort": comfort["comfort"],
        "comfort_advice": comfort["advice"],
    }
