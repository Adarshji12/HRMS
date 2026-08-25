"""Razorpay integration.

Implemented directly against the REST API rather than through the SDK: the
surface we need is two calls and two HMAC checks, and a thin implementation is
easier to audit than a dependency whose version drift can change signature
behaviour under us.

**The trust model matters here.** The browser handshake
(``razorpay_payment_id`` + ``razorpay_signature`` posted back by checkout) is
verified, but it is *not* what activates a subscription on its own — a caller
can simply never send it, or send it twice. The webhook is the authoritative
signal, and activation is idempotent so whichever arrives first wins and the
second is a no-op.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from dataclasses import dataclass

import httpx

from app.core.config import settings

log = logging.getLogger(__name__)

TIMEOUT = httpx.Timeout(10.0, connect=5.0)


class PaymentError(RuntimeError):
    """The gateway rejected the request or could not be reached."""


@dataclass(frozen=True)
class Order:
    id: str
    amount: int
    currency: str
    key_id: str
    simulated: bool = False


def _auth() -> tuple[str, str]:
    return settings.razorpay_key_id, settings.razorpay_key_secret


def create_order(amount: int, receipt: str, notes: dict | None = None) -> Order:
    """Create a Razorpay order. ``amount`` is in paise."""
    if amount <= 0:
        raise PaymentError("Order amount must be positive")

    if not settings.payments_configured:
        # Local/dev mode: no gateway credentials, so mint a plausible order id
        # and let the flow proceed. verify_payment_signature below accepts the
        # matching simulated signature and nothing else.
        if settings.razorpay_live:
            raise PaymentError(
                "RAZORPAY_LIVE is set but no API keys are configured; refusing to "
                "simulate payments."
            )
        log.warning("Razorpay keys absent - creating a SIMULATED order for %s", receipt)
        return Order(
            id=f"order_sim_{secrets.token_hex(8)}",
            amount=amount,
            currency="INR",
            key_id="rzp_test_simulated",
            simulated=True,
        )

    payload = {
        "amount": amount,
        "currency": "INR",
        "receipt": receipt[:40],
        # Razorpay only captures automatically when told to; without this the
        # money is authorised but never taken.
        "payment_capture": 1,
        "notes": notes or {},
    }
    try:
        response = httpx.post(
            f"{settings.razorpay_api_base}/orders",
            json=payload,
            auth=_auth(),
            timeout=TIMEOUT,
        )
    except httpx.HTTPError as exc:
        raise PaymentError(f"Could not reach the payment gateway: {exc}") from exc

    if response.status_code >= 400:
        raise PaymentError(_describe(response))

    body = response.json()
    return Order(
        id=body["id"],
        amount=int(body["amount"]),
        currency=body.get("currency", "INR"),
        key_id=settings.razorpay_key_id,
    )


def fetch_payment(payment_id: str) -> dict:
    """Ask the gateway what it thinks the payment's state is.

    Used to confirm before activating, so a forged callback cannot promote a
    subscription even if signature verification were somehow bypassed.
    """
    if not settings.payments_configured:
        return {"id": payment_id, "status": "captured", "method": "simulated"}
    try:
        response = httpx.get(
            f"{settings.razorpay_api_base}/payments/{payment_id}",
            auth=_auth(),
            timeout=TIMEOUT,
        )
    except httpx.HTTPError as exc:
        raise PaymentError(f"Could not reach the payment gateway: {exc}") from exc
    if response.status_code >= 400:
        raise PaymentError(_describe(response))
    return response.json()


def _simulated_signature(order_id: str, payment_id: str) -> str:
    # Signed with the app secret so a simulated confirmation still cannot be
    # forged by a caller who does not have it.
    return hmac.new(
        settings.secret_key.encode(), f"{order_id}|{payment_id}".encode(), hashlib.sha256
    ).hexdigest()


def verify_payment_signature(order_id: str, payment_id: str, signature: str) -> bool:
    """Verify the checkout callback.

    Razorpay signs ``order_id|payment_id`` with the API secret.
    """
    if not order_id or not payment_id or not signature:
        return False

    if not settings.payments_configured:
        expected = _simulated_signature(order_id, payment_id)
    else:
        expected = hmac.new(
            settings.razorpay_key_secret.encode(),
            f"{order_id}|{payment_id}".encode(),
            hashlib.sha256,
        ).hexdigest()

    # Constant-time: a plain == leaks the correct prefix through timing.
    return hmac.compare_digest(expected, signature)


def simulate_checkout(order_id: str) -> dict:
    """Produce the callback a real checkout would post back.

    Only usable while no gateway keys are configured; it lets the signup flow be
    tested end to end without credentials.
    """
    if settings.payments_configured:
        raise PaymentError("Simulation is unavailable once Razorpay keys are configured")
    payment_id = f"pay_sim_{secrets.token_hex(8)}"
    return {
        "razorpay_order_id": order_id,
        "razorpay_payment_id": payment_id,
        "razorpay_signature": _simulated_signature(order_id, payment_id),
    }


def verify_webhook_signature(body: bytes, signature: str) -> bool:
    """Verify an inbound webhook against the webhook secret.

    A webhook with no configured secret is rejected rather than trusted — an
    unauthenticated endpoint that activates subscriptions is worse than no
    webhook at all.
    """
    if not settings.razorpay_webhook_secret or not signature:
        return False
    expected = hmac.new(
        settings.razorpay_webhook_secret.encode(), body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def _describe(response: httpx.Response) -> str:
    try:
        error = response.json().get("error", {})
        return f"{error.get('code', response.status_code)}: {error.get('description', '')}"[:300]
    except ValueError:
        return f"HTTP {response.status_code}"[:300]
