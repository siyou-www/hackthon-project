"""Opt-in Web Push. PostgreSQL stores subscriptions separately from task SQLite."""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from functools import lru_cache
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pywebpush import WebPushException, webpush
from sqlalchemy import (Column, Float, MetaData, String, Table, Text, create_engine,
                        delete, insert, or_, select, update)
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

router = APIRouter(prefix="/api/push", tags=["notifications"])
metadata = MetaData()
subscriptions = Table(
    "push_subscriptions", metadata,
    Column("id", String(36), primary_key=True),
    Column("endpoint_hash", String(64), unique=True, nullable=False),
    Column("subscription", Text, nullable=False),
    Column("token_hash", String(64), nullable=False),
    Column("last_sent", Float, nullable=True),
)
SEND_INTERVAL_SECONDS = 60


def decode_key(value, length):
    if not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", value):
        raise ValueError("Invalid push key")
    decoded = base64.urlsafe_b64decode(value.rstrip("=") + "=" * (-len(value.rstrip("=")) % 4))
    if len(decoded) != length:
        raise ValueError("Invalid push key")
    return decoded


class PushKeys(BaseModel):
    model_config = ConfigDict(extra="forbid")
    p256dh: str = Field(max_length=100)
    auth: str = Field(max_length=30)

    @field_validator("p256dh")
    @classmethod
    def valid_public_key(cls, value):
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), decode_key(value, 65))
        return value

    @field_validator("auth")
    @classmethod
    def valid_auth(cls, value):
        decode_key(value, 16)
        return value


class PushSubscription(BaseModel):
    model_config = ConfigDict(extra="forbid")
    endpoint: str = Field(max_length=2048)
    keys: PushKeys
    expirationTime: float | None = None

    @field_validator("endpoint")
    @classmethod
    def valid_endpoint(cls, value):
        # Prevent caller-controlled server-side HTTP requests to arbitrary hosts.
        url = urlsplit(value)
        host = url.hostname or ""
        allowed = (host in {"fcm.googleapis.com", "updates.push.services.mozilla.com"}
                   or host.endswith(".push.apple.com")
                   or host.endswith(".notify.windows.com"))
        if (url.scheme != "https" or not allowed or url.port not in (None, 443)
                or url.username or url.password or url.fragment or not url.path.startswith("/")):
            raise ValueError("Use a supported HTTPS browser push endpoint")
        return value


class RegisterRequest(BaseModel):
    subscription: PushSubscription
    # Only an existing capability holder can update an already registered endpoint.
    token: str | None = Field(default=None, min_length=32, max_length=128)


@lru_cache(maxsize=1)
def get_engine():
    value = os.getenv("PUSH_DATABASE_URL", "")
    if value.startswith("postgres://"):
        value = value.replace("postgres://", "postgresql+psycopg://", 1)
    elif value.startswith("postgresql://"):
        value = value.replace("postgresql://", "postgresql+psycopg://", 1)
    try:
        url = make_url(value)
        if url.get_backend_name() != "postgresql":
            if not (url.get_backend_name() == "sqlite" and os.getenv("PUSH_ALLOW_SQLITE") == "1"
                    and not os.getenv("RENDER")):
                raise ValueError
        engine = create_engine(url, pool_pre_ping=True)
        metadata.create_all(engine)
        return engine
    except (ValueError, SQLAlchemyError):
        raise HTTPException(503, "Notification database is not configured or unavailable.") from None


def database():
    try:
        # Each HTTP request gets one transaction, including atomic rate-limit claims.
        with get_engine().begin() as connection:
            yield connection
    except SQLAlchemyError:
        raise HTTPException(503, "Notification database is unavailable.") from None


def vapid_config():
    try:
        private = os.environ["VAPID_PRIVATE_KEY"]
        public = os.environ["VAPID_PUBLIC_KEY"]
        subject = os.environ["VAPID_SUBJECT"]
        key = ec.derive_private_key(int.from_bytes(decode_key(private, 32), "big"), ec.SECP256R1())
        expected = key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        if not hmac.compare_digest(expected, decode_key(public, 65)):
            raise ValueError
        if not (subject.startswith("mailto:") and "@" in subject[7:]) and not (
            subject.startswith("https://") and urlsplit(subject).hostname):
            raise ValueError
        return private, public, subject
    except (KeyError, ValueError):
        raise HTTPException(503, "Notifications are not configured. Contact the DayCast operator.") from None


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def authorize(connection, subscription_id, authorization):
    token = authorization.removeprefix("Bearer ") if authorization else ""
    row = connection.execute(select(subscriptions).where(subscriptions.c.id == str(subscription_id))).mappings().first()
    if not row or not authorization or not authorization.startswith("Bearer ") or not hmac.compare_digest(row["token_hash"], digest(token)):
        raise HTTPException(403, "Invalid notification capability.")
    return row


@router.get("/public-key")
def public_key():
    _, public, _ = vapid_config()
    return {"public_key": public}


@router.post("/subscriptions", status_code=201)
def register(request: RegisterRequest, connection=Depends(database)):
    vapid_config()
    info = request.subscription.model_dump(exclude={"expirationTime"})
    endpoint_hash = digest(info["endpoint"])
    row = connection.execute(select(subscriptions).where(subscriptions.c.endpoint_hash == endpoint_hash)).mappings().first()
    if row:
        if not request.token or not hmac.compare_digest(row["token_hash"], digest(request.token)):
            raise HTTPException(409, "Subscription already registered. Disable and re-enable browser notifications to recover access.")
        connection.execute(update(subscriptions).where(subscriptions.c.id == row["id"]).values(subscription=json.dumps(info)))
        return {"id": row["id"], "token": request.token}
    token = secrets.token_urlsafe(32)
    subscription_id = str(uuid4())
    try:
        connection.execute(insert(subscriptions).values(
            id=subscription_id, endpoint_hash=endpoint_hash, subscription=json.dumps(info), token_hash=digest(token)))
    except IntegrityError:
        raise HTTPException(409, "Subscription registration conflict. Please retry.") from None
    return {"id": subscription_id, "token": token}


@router.delete("/subscriptions/{subscription_id}")
def unregister(subscription_id: UUID, authorization: str | None = Header(default=None), connection=Depends(database)):
    authorize(connection, subscription_id, authorization)
    connection.execute(delete(subscriptions).where(subscriptions.c.id == str(subscription_id)))
    return {"status": "unregistered"}


@router.post("/subscriptions/{subscription_id}/test")
def send_test(subscription_id: UUID, authorization: str | None = Header(default=None), connection=Depends(database)):
    private, _, subject = vapid_config()
    row = authorize(connection, subscription_id, authorization)
    now = time.time()
    claimed = connection.execute(update(subscriptions).where(
        subscriptions.c.id == str(subscription_id),
        or_(subscriptions.c.last_sent.is_(None), subscriptions.c.last_sent <= now - SEND_INTERVAL_SECONDS),
    ).values(last_sent=now))
    if claimed.rowcount != 1:
        raise HTTPException(429, "Wait 60 seconds before sending another test.", headers={"Retry-After": "60"})
    # Persist the claim even if delivery fails, to prevent retry abuse across workers.
    connection.commit()
    try:
        webpush(
            subscription_info=json.loads(row["subscription"]),
            data=json.dumps({"title": "DayCast test notification", "body": "Notifications are enabled. Have a great day!"}),
            vapid_private_key=private, vapid_claims={"sub": subject}, ttl=300, timeout=10,
        )
    except WebPushException as error:
        status = error.response.status_code if error.response is not None else None
        if status in (404, 410):
            with get_engine().begin() as cleanup:
                cleanup.execute(delete(subscriptions).where(subscriptions.c.id == str(subscription_id)))
            raise HTTPException(410, "Subscription expired. Enable notifications again.") from None
        raise HTTPException(502, "Push delivery failed. Please try again later.") from None
    except Exception:
        # Provider/library errors can contain endpoint URLs and credentials: never echo them.
        raise HTTPException(502, "Push delivery failed. Please try again later.") from None
    return {"status": "accepted"}
