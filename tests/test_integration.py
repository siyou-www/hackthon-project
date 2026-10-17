from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

import main


def test_weather_to_daily_plan_integration():
    client = TestClient(main.app)

    # Mock Open-Meteo's hourly forecast
    forecast = {
        "timezone": "America/Los_Angeles",
        "hourly": {
            "time": [
                "2026-10-16T14:00",
                "2026-10-16T15:00",
            ],
            "temperature_2m": [32, 20],
            "precipitation_probability": [70, 10],
        },
    }

    coordinates = {
        "latitude": 34.0522,
        "longitude": -118.2437,
    }

    mock_response = httpx.Response(
        200,
        json=forecast,
        request=httpx.Request(
            "GET", "https://api.open-meteo.com/v1/forecast"
        ),
    )

    with patch.object(
        httpx.AsyncClient, "get", new_callable=AsyncMock
    ) as mock_get:
        mock_get.return_value = mock_response

        # Step 1: Fetch weather through our backend
        weather_response = client.get(
            "/api/weather", params=coordinates
        )
        assert weather_response.status_code == 200

        hourly = weather_response.json()["hourly"]
        selected_time = hourly[0]["time"]

        # Step 2: Reuse the exact timestamp for Daily Plan
        plan_response = client.post(
            "/api/daily-plan",
            json={
                **coordinates,
                "activities": [
                    {
                        "time": selected_time,
                        "title": "Play basketball",
                        "outdoor": True,
                    }
                ],
            },
        )

        # Step 3: Verify both APIs agree
        assert plan_response.status_code == 200

        activity = plan_response.json()["activities"][0]

        assert activity["activity"]["time"] == selected_time
        assert activity["weather"] == hourly[0]
        assert isinstance(activity["advice"], list)
        assert len(activity["advice"]) > 0

        # Each endpoint should fetch the mocked forecast once
        assert mock_get.await_count == 2


def test_multiple_activities_from_weather_timeline():
    client = TestClient(main.app)

    forecast = {
        "timezone": "America/Los_Angeles",
        "hourly": {
            "time": [
                "2026-10-16T14:00",
                "2026-10-16T15:00",
            ],
            "temperature_2m": [32, 20],
            "precipitation_probability": [70, 10],
        },
    }

    mock_response = httpx.Response(
        200,
        json=forecast,
        request=httpx.Request(
            "GET", "https://api.open-meteo.com/v1/forecast"
        ),
    )

    coordinates = {
        "latitude": 34.0522,
        "longitude": -118.2437,
    }

    with patch.object(
        httpx.AsyncClient, "get", new_callable=AsyncMock
    ) as mock_get:
        mock_get.return_value = mock_response

        weather_response = client.get(
            "/api/weather", params=coordinates
        )
        assert weather_response.status_code == 200

        hourly = weather_response.json()["hourly"]

        activities = [
            {
                "time": hourly[0]["time"],
                "title": "Play basketball",
                "outdoor": True,
            },
            {
                "time": hourly[1]["time"],
                "title": "Walking",
                "outdoor": True,
            },
        ]

        plan_response = client.post(
            "/api/daily-plan",
            json={**coordinates, "activities": activities},
        )

        assert plan_response.status_code == 200

        results = plan_response.json()["activities"]
        assert len(results) == 2

        for i in range(2):
            assert results[i]["activity"] == activities[i]
            assert results[i]["weather"] == hourly[i]
            assert isinstance(results[i]["advice"], list)
            assert len(results[i]["advice"]) > 0

        assert mock_get.await_count == 2
