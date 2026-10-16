
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
import sqlite3

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_NAME = "tasks.db"


# ---------- Database ----------

def get_db_connection():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db_connection()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            completed BOOLEAN NOT NULL DEFAULT 0
        )
    """)

    conn.commit()
    conn.close()


init_db()


# ---------- Data Models ----------

class TaskCreate(BaseModel):
    title: str = Field(min_length=1)

    @field_validator("title")
    @classmethod
    def title_must_not_be_blank(cls, value):
        if not value.strip():
            raise ValueError("Title cannot be blank")
        return value.strip()


class TaskUpdate(BaseModel):
    title: str = Field(min_length=1)

    @field_validator("title")
    @classmethod
    def title_must_not_be_blank(cls, value):
        if not value.strip():
            raise ValueError("Title cannot be blank")
        return value.strip()


# ---------- Health Check ----------

@app.get("/health")
def health_check():
    return {"status": "ok"}


# ---------- Create Task ----------

@app.post("/tasks")
def create_task(task_data: TaskCreate):
    conn = get_db_connection()

    try:
        cursor = conn.execute(
            "INSERT INTO tasks (title) VALUES (?)",
            (task_data.title,)
        )
        conn.commit()

        task_id = cursor.lastrowid

        row = conn.execute(
            "SELECT * FROM tasks WHERE id = ?",
            (task_id,)
        ).fetchone()

        return dict(row)
    finally:
        conn.close()


# ---------- Get All Tasks / Filter ----------

@app.get("/tasks")
def get_tasks(completed: bool | None = None):
    conn = get_db_connection()

    try:
        if completed is None:
            rows = conn.execute(
                "SELECT * FROM tasks ORDER BY id"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM tasks WHERE completed = ? ORDER BY id",
                (completed,)
            ).fetchall()

        return {"tasks": [dict(row) for row in rows]}
    finally:
        conn.close()

@app.get("/tasks/stats")
def get_task_stats():
    conn = get_db_connection()

    try:
        row = conn.execute("""
            SELECT
                COUNT(*) AS total_tasks,
                COALESCE(SUM(completed = 1), 0) AS completed_tasks,
                COALESCE(SUM(completed = 0), 0) AS pending_tasks
            FROM tasks
        """).fetchone()

        return dict(row)
    finally:
        conn.close()

@app.get("/tasks/search")
def search_tasks(q: str):
    conn = get_db_connection()

    try:
        rows = conn.execute(
            "SELECT * FROM tasks WHERE title LIKE ? ORDER BY id",
            (f"%{q}%",)
        ).fetchall()

        return {"tasks": [dict(row) for row in rows]}
    finally:
        conn.close()


# ---------- Get One Task ----------

@app.get("/tasks/{task_id}")
def get_task(task_id: int):
    conn = get_db_connection()

    try:
        row = conn.execute(
            "SELECT * FROM tasks WHERE id = ?",
            (task_id,)
        ).fetchone()

        if row is None:
            raise HTTPException(
                status_code=404,
                detail="Task not found"
            )

        return dict(row)
    finally:
        conn.close()


# ---------- Complete Task ----------

@app.patch("/tasks/{task_id}/complete")
def complete_task(task_id: int):
    conn = get_db_connection()

    try:
        cursor = conn.execute(
            "UPDATE tasks SET completed = 1 WHERE id = ?",
            (task_id,)
        )
        conn.commit()

        if cursor.rowcount == 0:
            raise HTTPException(
                status_code=404,
                detail="Task not found"
            )

        row = conn.execute(
            "SELECT * FROM tasks WHERE id = ?",
            (task_id,)
        ).fetchone()

        return dict(row)
    finally:
        conn.close()


# ---------- Delete Task ----------

@app.delete("/tasks/{task_id}")
def delete_task(task_id: int):
    conn = get_db_connection()

    try:
        cursor = conn.execute(
            "DELETE FROM tasks WHERE id = ?",
            (task_id,)
        )
        conn.commit()

        if cursor.rowcount == 0:
            raise HTTPException(
                status_code=404,
                detail="Task not found"
            )

        return {"message": "Task deleted successfully"}
    finally:
        conn.close()


# ---------- Update Task Title ----------

@app.put("/tasks/{task_id}")
def update_task(task_id: int, task_data: TaskUpdate):
    conn = get_db_connection()

    try:
        cursor = conn.execute(
            "UPDATE tasks SET title = ? WHERE id = ?",
            (task_data.title, task_id)
        )
        conn.commit()

        if cursor.rowcount == 0:
            raise HTTPException(
                status_code=404,
                detail="Task not found"
            )

        row = conn.execute(
            "SELECT * FROM tasks WHERE id = ?",
            (task_id,)
        ).fetchone()

        return dict(row)
    finally:
        conn.close()