# Hackathon Project

A task management API built with Python, FastAPI, and SQLite.

## Requirements

- Python 3.10 or newer
- Git

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/siyou-www/hackthon-project.git
cd hackthon-project
```

### 2. Install dependencies

```bash
python -m pip install -r requirements.txt
```

### 3. Start the API server

```bash
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

### 4. Open the API documentation

Visit:

http://127.0.0.1:8000/docs

## Main Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Check server status |
| POST | `/tasks` | Create a task |
| GET | `/tasks` | List tasks |
| GET | `/tasks/stats` | Get task statistics |
| GET | `/tasks/search?q=keyword` | Search tasks |
| GET | `/tasks/{task_id}` | Get one task |
| PUT | `/tasks/{task_id}` | Update a task |
| PATCH | `/tasks/{task_id}/complete` | Complete a task |
| DELETE | `/tasks/{task_id}` | Delete a task |

## DayCast hourly weather

`GET /api/weather?latitude=34.0522&longitude=-118.2437` fetches real hourly
Open-Meteo forecasts in the location's local timezone. Each hourly entry contains
`time`, `temperature_c`, `temperature_f`, and `precipitation_probability`.
Latitude must be between -90 and 90; longitude must be between -180 and 180.
Invalid query parameters return 422, upstream failures or incomplete data return
502, and upstream timeouts return 504, with JSON error details.

With the API server running, verify manually:

```bash
curl 'http://127.0.0.1:8000/api/weather?latitude=34.0522&longitude=-118.2437'
```

Outbound HTTPS access to `api.open-meteo.com` is required; no API key is needed.
Run the mocked weather tests and task API regression checks with:

```bash
python -m unittest discover -s tests -v
```

## DayCast personalized daily plan

`POST /api/daily-plan` matches activities to the hourly forecast and returns
rule-based advice. It fetches the forecast once per request and preserves activity
order. Plans are not stored. No API key, AI service, or extra database is needed.

Request JSON schema (all fields required):

| Field | Type | Validation |
|---|---|---|
| `latitude` | number | -90 through 90 |
| `longitude` | number | -180 through 180 |
| `activities` | array of activity objects | At least one activity |
| `activities[].time` | string | Exact `YYYY-MM-DDTHH:00` local hour from `/api/weather`; no offset or seconds |
| `activities[].title` | string | Nonblank; surrounding whitespace is removed |
| `activities[].outdoor` | boolean | Whether the activity is outdoors |

Use timestamps from the timeline returned by `GET /api/weather` for the same
coordinates. These represent local wall-clock hours in the returned `timezone`,
not UTC. This MVP does not distinguish repeated local hours during daylight-saving
transitions. Activities may use different forecast days; each must match an
available hourly timestamp.

Example request:

```json
{
  "latitude": 34.0522,
  "longitude": -118.2437,
  "activities": [
    {"time": "2026-10-16T14:00", "title": "Play basketball", "outdoor": true}
  ]
}
```

Response JSON schema: `timezone` is a string; `activities` is an array in request
order. Each item contains `activity` (the validated input object), `weather`
(`time`: string, `temperature_c`: number, `temperature_f`: number,
`precipitation_probability`: number from 0 to 100), and `advice` (array of strings).

Exact response for mocked weather of 32°C and 70% rain probability (example data,
not a live forecast):

```json
{
  "timezone": "America/Los_Angeles",
  "activities": [
    {
      "activity": {
        "time": "2026-10-16T14:00",
        "title": "Play basketball",
        "outdoor": true
      },
      "weather": {
        "time": "2026-10-16T14:00",
        "temperature_c": 32,
        "temperature_f": 89.6,
        "precipitation_probability": 70
      },
      "advice": [
        "Bring an umbrella or consider an indoor alternative.",
        "Stay hydrated and use sun protection."
      ]
    }
  ]
}
```

Rules: temperature >=30°C triggers hydration and sun protection; <=10°C triggers
an extra layer; rain probability >=60% triggers an umbrella warning. Outdoor
advice prioritizes rain and suggests an indoor alternative; indoor advice concerns
travel to the activity. Mild, dry hours receive a neutral message.

Invalid input, non-hourly times, or unavailable forecast hours return 422.
Unavailable hours reject the whole request, with JSON `detail` entries identifying
`["body", "activities", index, "time"]`. Upstream failures and invalid forecast
data return 502; timeouts return 504, as with `/api/weather`.

To verify manually, start the server as above, choose a current timestamp from
`/api/weather`, and send the request body saved in `plan.json`:

```bash
curl -X POST 'http://127.0.0.1:8000/api/daily-plan' \
  -H 'Content-Type: application/json' --data-binary @plan.json
```

Run both existing and new mocked tests with
`python -m unittest discover -s tests -v`.

## Database

Tasks are stored locally in SQLite. The database file is created automatically when the application initializes.

## Phase 1 Web Push notifications

Opt-in Home Screen PWA test notifications are documented in
[Web Push setup and deployment](docs/web-push.md). Production subscriptions require
PostgreSQL plus backend VAPID configuration; existing task SQLite is unchanged.
