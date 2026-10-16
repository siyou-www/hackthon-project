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

## Database

Tasks are stored locally in SQLite. The database file is created automatically when the application initializes.
