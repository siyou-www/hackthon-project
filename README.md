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

## Database

Tasks are stored locally in SQLite. The database file is created automatically when the application initializes.
