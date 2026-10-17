"""Capability-scoped reminder persistence only. This module never sends pushes."""
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from push_notifications import authorize, database, reminders

router = APIRouter(prefix="/api/push/subscriptions", tags=["reminders"])
UTC = timezone.utc


def utc_now():
    return datetime.now(UTC)


def local_start(time, zone):
    """Round-trip both folds: zero instants means a DST gap, two an ambiguity."""
    naive = datetime.strptime(time, "%Y-%m-%dT%H:%M")
    if naive.strftime("%Y-%m-%dT%H:%M") != time or naive.minute != 0:
        raise ValueError("Use an hourly local time in YYYY-MM-DDTHH:00 format")
    zone = ZoneInfo(zone)
    candidates = set()
    for fold in (0, 1):
        instant = naive.replace(tzinfo=zone, fold=fold).astimezone(UTC)
        if instant.astimezone(zone).replace(tzinfo=None) == naive:
            candidates.add(instant)
    if not candidates:
        raise ValueError("Local time does not exist in this timezone")
    if len(candidates) != 1:
        raise ValueError("Local time is ambiguous in this timezone; choose another hour")
    return candidates.pop()


class ReminderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    time: str = Field(min_length=16, max_length=16)
    timezone: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=200)
    outdoor: StrictBool
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    preference: Literal["cold_sensitive", "normal", "heat_sensitive"] = "normal"

    @field_validator("title")
    @classmethod
    def nonblank_title(cls, value):
        if not value.strip():
            raise ValueError("Title cannot be blank")
        return value.strip()

    @model_validator(mode="after")
    def valid_local_time(self):
        try:
            local_start(self.time, self.timezone)
        except (ZoneInfoNotFoundError, OverflowError):
            raise ValueError("Use a valid IANA timezone and supported local date") from None
        return self


def as_utc(value):
    # SQLite local tests return naive datetimes; PostgreSQL uses TIMESTAMPTZ.
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def public_reminder(row):
    result = dict(row)
    # Return reminder data only, never subscription endpoints, keys, or capabilities.
    for key, value in result.items():
        if isinstance(value, datetime):
            result[key] = as_utc(value).isoformat().replace("+00:00", "Z")
    return result


def find_reminder(connection, subscription_id, activity_id):
    return connection.execute(select(reminders).where(
        reminders.c.subscription_id == str(subscription_id),
        reminders.c.activity_id == str(activity_id),
    ).with_for_update()).mappings().first()


@router.put("/{subscription_id}/reminders/{activity_id}")
def put_reminder(subscription_id: UUID, activity_id: UUID, request: ReminderRequest,
                 authorization: str | None = Header(default=None), connection=Depends(database)):
    # A parent-row lock serializes writes and subscription deletion in PostgreSQL.
    authorize(connection, subscription_id, authorization, lock=True)
    starts_at = local_start(request.time, request.timezone)
    due_at = starts_at - timedelta(minutes=30)
    values = request.model_dump(exclude={"time"})
    values.update(starts_at=starts_at, due_at=due_at)
    row = find_reminder(connection, subscription_id, activity_id)
    if row and row["status"] != "pending":
        raise HTTPException(409, "Only pending reminders can be updated. Use a new activity UUID for a new reminder.")
    if row and all((as_utc(row[key]) == value if isinstance(value, datetime) else row[key] == value)
                   for key, value in values.items()):
        # A retry of an accepted save is a no-op, even after its lead time passes.
        return public_reminder(row)
    now = utc_now()
    if starts_at < now + timedelta(minutes=30):
        raise HTTPException(422, "Activity must start at least 30 minutes in the future.")
    if row:
        connection.execute(update(reminders).where(reminders.c.id == row["id"]).values(
            **values, next_attempt_at=due_at, updated_at=now))
    else:
        insert = pg_insert if connection.dialect.name == "postgresql" else sqlite_insert
        # Unique key also protects against duplicate inserts in local SQLite tests.
        statement = insert(reminders).values(
            **values, id=str(uuid4()), subscription_id=str(subscription_id),
            activity_id=str(activity_id), status="pending", attempt_count=0,
            next_attempt_at=due_at, created_at=now, updated_at=now,
        ).on_conflict_do_nothing(index_elements=["subscription_id", "activity_id"])
        connection.execute(statement)
    return public_reminder(find_reminder(connection, subscription_id, activity_id))


@router.get("/{subscription_id}/reminders")
def list_reminders(subscription_id: UUID, authorization: str | None = Header(default=None),
                   connection=Depends(database)):
    authorize(connection, subscription_id, authorization)
    rows = connection.execute(select(reminders).where(
        reminders.c.subscription_id == str(subscription_id),
    ).order_by(reminders.c.starts_at, reminders.c.id)).mappings()
    return {"reminders": [public_reminder(row) for row in rows]}


@router.delete("/{subscription_id}/reminders/{activity_id}")
def cancel_reminder(subscription_id: UUID, activity_id: UUID,
                    authorization: str | None = Header(default=None), connection=Depends(database)):
    authorize(connection, subscription_id, authorization, lock=True)
    row = find_reminder(connection, subscription_id, activity_id)
    if row is None:
        raise HTTPException(404, "Reminder not found.")
    if row["status"] == "cancelled":
        return public_reminder(row)
    if row["status"] not in ("pending", "retry"):
        raise HTTPException(409, "This reminder can no longer be cancelled.")
    now = utc_now()
    connection.execute(update(reminders).where(reminders.c.id == row["id"]).values(
        status="cancelled", cancelled_at=now, updated_at=now, next_attempt_at=None, lease_until=None))
    return public_reminder(find_reminder(connection, subscription_id, activity_id))
