# API Specification

Base URL: http://127.0.0.1:8000

## Health Check
GET /health

Response:
{
  "status": "ok"
}

## Create Task
POST /tasks

Request:
{
  "title": "Study Python"
}

Response:
{
  "id": 1,
  "title": "Study Python",
  "completed": 0
}

## List Tasks
GET /tasks

Response:
{
  "tasks": []
}

## Task Statistics
GET /tasks/stats

Response:
{
  "total_tasks": 0,
  "completed_tasks": 0,
  "pending_tasks": 0
}