"""Outbound email.

With no SMTP connector configured the message is written to the log instead of
sent, in full, including any link it contains. That is what makes signup,
invitations, password reset and every alert testable before anyone has set up a
mail provider — and it is why the fallback logs at WARNING: a deployment that
has quietly lost its connector should be noisy, not silently dropping password
resets.

The connector itself is configured in the platform console and read from the
database on each send (see app.services.mailconfig), so pointing it at a new
provider takes effect immediately and needs no restart.

Sending is synchronous. At real volume, hand these off to a queue (RQ, Celery,
or a transactional-email provider's API) — an SMTP handshake inside a request is
a slow endpoint waiting to happen.
"""

from __future__ import annotations

import logging
import smtplib
from contextvars import ContextVar
import ssl
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

from app.core.config import settings
from app.services import mailconfig

log = logging.getLogger(__name__)

#: Set by send() so a caller can report *why* delivery failed.
_LAST_ERROR: ContextVar[str | None] = ContextVar("mail_last_error", default=None)


class EmailError(RuntimeError):
    pass


def _build(to: str, subject: str, body: str, sender: str, html: str | None = None) -> EmailMessage:
    message = EmailMessage()
    name, address = parseaddr(sender)
    message["From"] = formataddr((name or settings.app_name, address or "no-reply@localhost"))
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)
    if html:
        message.add_alternative(html, subtype="html")
    return message


def send(
    to: str,
    subject: str,
    body: str,
    html: str | None = None,
    org_id=None,
) -> bool:
    """Returns True if handed to an SMTP server, False if only logged.

    The connector is resolved per call rather than read from ``settings`` at
    import time: it now lives in the database, where an operator can change it
    from the platform console without restarting the API.
    """
    # org_id selects the workspace's own connector when it has one. Without it
    # every tenant's mail would leave through the platform default, which is
    # exactly the "why does this arrive from someone else's domain" problem.
    config = mailconfig.resolve(org_id=org_id)
    message = _build(to, subject, body, config.sender, html)

    if not config.configured:
        log.warning(
            "SMTP not configured - email NOT sent.\n"
            "  To      : %s\n  Subject : %s\n%s\n%s",
            to, subject, "-" * 68, body,
        )
        return False

    _LAST_ERROR.set(None)
    try:
        _deliver(config, message)
    except (smtplib.SMTPException, OSError) as exc:
        # Never re-raise into the caller's request: a signup must not fail
        # because the welcome mail bounced. Failures are logged and, where it
        # matters, the link is also returned in the API response.
        log.error("could not send %r to %s: %s", subject, to, exc)
        # Returning a bare False loses the one thing needed to fix it. An
        # authentication rejection, an unknown recipient and a firewalled port
        # all look identical from the caller, and "see the server log" is not
        # an answer for anyone reading the dashboard instead.
        _LAST_ERROR.set(f"{type(exc).__name__}: {exc}"[:2000])
        return False

    log.info("sent %r to %s", subject, to)
    return True


def last_error() -> str | None:
    """Why the most recent send() in this task failed, if it did.

    A ContextVar rather than a module global: the API serves requests
    concurrently, and a global would hand one request another's failure.
    """
    return _LAST_ERROR.get()


def _deliver(config: "mailconfig.MailConfig", message: EmailMessage) -> None:
    """One place that actually talks SMTP, so the test button and the alert
    runner cannot drift apart on TLS handling or timeouts."""
    if config.port == 465:
        # Implicit TLS. STARTTLS on 465 is a protocol error, not a fallback, so
        # the port decides the mode and use_tls is ignored here.
        with smtplib.SMTP_SSL(
            config.host, config.port, context=ssl.create_default_context(), timeout=15
        ) as server:
            _login_and_send(server, config, message)
    else:
        with smtplib.SMTP(config.host, config.port, timeout=15) as server:
            if config.use_tls:
                server.starttls(context=ssl.create_default_context())
            _login_and_send(server, config, message)


def _login_and_send(
    server: smtplib.SMTP, config: "mailconfig.MailConfig", message: EmailMessage
) -> None:
    if config.user:
        server.login(config.user, config.password)
    server.send_message(message)


# --------------------------------------------------------------------------- #
# Templates
# --------------------------------------------------------------------------- #

_WRAPPER = """<!doctype html>
<html><body style="margin:0;background:#f7f7fb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;
              border:1px solid rgba(20,18,31,.09);overflow:hidden">
    <div style="padding:20px 28px;border-bottom:1px solid rgba(20,18,31,.09)">
      <span style="font-size:18px;font-weight:750;letter-spacing:-.035em">
        <span style="color:#7c56ee">MyDesk</span><span style="color:#3d0fa6">Time</span>
      </span>
    </div>
    <div style="padding:28px;color:#14121f;font-size:14px;line-height:1.65">{body}</div>
    <div style="padding:16px 28px;border-top:1px solid rgba(20,18,31,.09);
                color:#8c89a3;font-size:12px">{footer}</div>
  </div>
</body></html>"""


def _button(url: str, label: str) -> str:
    return (
        f'<p style="margin:24px 0"><a href="{url}" '
        f'style="background:#5b18d9;color:#fff;text-decoration:none;padding:11px 20px;'
        f'border-radius:8px;display:inline-block;font-weight:600">{label}</a></p>'
        # The bare URL is always included: corporate mail clients strip or
        # rewrite buttons, and a link nobody can click is a support ticket.
        f'<p style="color:#55526b;font-size:12px">If the button does not work, '
        f'copy this address:<br><span style="word-break:break-all">{url}</span></p>'
    )


def send_welcome(to: str, name: str, org_name: str, login_url: str, plan_name: str, org_id=None) -> bool:
    body = (
        f"Hi {name},\n\n"
        f"{org_name} is set up on {settings.app_name} ({plan_name}).\n\n"
        f"Sign in: {login_url}\n\n"
        f"Next: add your employees, then install the desktop agent on their machines.\n"
    )
    html = _WRAPPER.format(
        body=(
            f"<p>Hi {name},</p>"
            f"<p><b>{org_name}</b> is set up on {settings.app_name}, on the "
            f"<b>{plan_name}</b> plan.</p>"
            + _button(login_url, "Open your dashboard")
            + "<p>Next: add your employees, then install the desktop agent on "
            "their machines.</p>"
        ),
        footer=f"You received this because an account was created for {to}.",
    )
    return send(to, f"{org_name} is ready on {settings.app_name}", body, html, org_id=org_id)


def send_invitation(to: str, org_name: str, inviter: str, accept_url: str, hours: int, org_id=None) -> bool:
    body = (
        f"{inviter} invited you to {org_name} on {settings.app_name}.\n\n"
        f"Accept: {accept_url}\n\n"
        f"This link expires in {hours} hours.\n"
    )
    html = _WRAPPER.format(
        body=(
            f"<p><b>{inviter}</b> invited you to join <b>{org_name}</b> on "
            f"{settings.app_name}.</p>" + _button(accept_url, "Accept invitation")
            + f"<p style='color:#55526b'>This link expires in {hours} hours.</p>"
        ),
        footer="If you were not expecting this, you can ignore this email.",
    )
    return send(to, f"Join {org_name} on {settings.app_name}", body, html, org_id=org_id)


def send_password_reset(to: str, name: str, reset_url: str, hours: int, org_id=None) -> bool:
    body = (
        f"Hi {name},\n\nReset your password: {reset_url}\n\n"
        f"This link expires in {hours} hours. If you did not request it, "
        f"ignore this email — your password will not change.\n"
    )
    html = _WRAPPER.format(
        body=(
            f"<p>Hi {name},</p><p>Use the link below to choose a new password.</p>"
            + _button(reset_url, "Reset password")
            + f"<p style='color:#55526b'>Expires in {hours} hours. If you did not "
            "request this, ignore it — your password will not change.</p>"
        ),
        footer="Sent because a password reset was requested for this address.",
    )
    return send(to, f"Reset your {settings.app_name} password", body, html, org_id=org_id)


def send_payment_receipt(
    to: str, org_name: str, plan_name: str, seats: int, amount_paise: int, period_end: str,
    org_id=None,
) -> bool:
    amount = f"₹{amount_paise / 100:,.2f}"
    body = (
        f"Payment received for {org_name}.\n\n"
        f"Plan   : {plan_name}\nSeats  : {seats}\nAmount : {amount} (incl. GST)\n"
        f"Active until: {period_end}\n"
    )
    html = _WRAPPER.format(
        body=(
            f"<p>Payment received for <b>{org_name}</b>.</p>"
            f"<table style='border-collapse:collapse;font-size:14px'>"
            f"<tr><td style='padding:4px 16px 4px 0;color:#55526b'>Plan</td>"
            f"<td><b>{plan_name}</b></td></tr>"
            f"<tr><td style='padding:4px 16px 4px 0;color:#55526b'>Seats</td>"
            f"<td>{seats}</td></tr>"
            f"<tr><td style='padding:4px 16px 4px 0;color:#55526b'>Amount</td>"
            f"<td><b>{amount}</b> incl. GST</td></tr>"
            f"<tr><td style='padding:4px 16px 4px 0;color:#55526b'>Active until</td>"
            f"<td>{period_end}</td></tr></table>"
        ),
        footer="This is a payment confirmation, not a tax invoice.",
    )
    return send(to, f"Payment received - {org_name}", body, html, org_id=org_id)


# --------------------------------------------------------------------------- #
# Alerts
#
# Every one of these ends with the same two things: what to do about it, and how
# to stop receiving it. A monitoring product that mails its own staff without an
# obvious way out earns the folder rule it gets.
# --------------------------------------------------------------------------- #


def _alert_footer(manage_url: str | None) -> str:
    if not manage_url:
        return "Sent by MyDeskTime."
    return (
        "You are receiving this because of your notification settings. "
        f'<a href="{manage_url}" style="color:#5b18d9">Change what you receive</a>.'
    )


def send_agent_silent(
    to: str, name: str, hostname: str, last_seen_local: str, gap_minutes: int,
    console_url: str, manage_url: str | None = None,
    org_id=None,
) -> bool:
    gap = f"{gap_minutes // 60}h {gap_minutes % 60}m" if gap_minutes >= 60 else f"{gap_minutes}m"
    body = (
        f"Hi {name},\n\n"
        f"MyDeskTime has not heard from {hostname} for {gap}.\n"
        f"Last report: {last_seen_local}\n\n"
        f"Time worked while the agent is down is not recorded and cannot be "
        f"recovered afterwards. If you are working, check that the agent is "
        f"running in your system tray and start it again if it is not.\n\n"
        f"{console_url}\n"
    )
    html = _WRAPPER.format(
        body=(
            f"<p>Hi {name},</p>"
            f"<p>MyDeskTime has not heard from <b>{hostname}</b> for <b>{gap}</b>.</p>"
            f"<p style='color:#55526b'>Last report: {last_seen_local}</p>"
            f"<p>Time worked while the agent is down is <b>not recorded</b>, and "
            f"cannot be recovered afterwards. If you are working, check that the "
            f"agent is running in your system tray and start it again if it is not.</p>"
            + _button(console_url, "Open MyDeskTime")
        ),
        footer=_alert_footer(manage_url),
    )
    return send(to, f"Your MyDeskTime agent stopped reporting ({gap})", body, html, org_id=org_id)


def send_timesheet_decided(
    to: str, name: str, decision: str, period: str, reviewer: str,
    note: str, url: str, manage_url: str | None = None,
    org_id=None,
) -> bool:
    approved = decision == "approved"
    headline = "approved" if approved else "returned for changes"
    body = (
        f"Hi {name},\n\n"
        f"Your timesheet for {period} was {headline} by {reviewer}.\n"
        + (f"\nNote: {note}\n" if note else "")
        + f"\n{url}\n"
    )
    html = _WRAPPER.format(
        body=(
            f"<p>Hi {name},</p>"
            f"<p>Your timesheet for <b>{period}</b> was <b>{headline}</b> by {reviewer}.</p>"
            + (
                f"<p style='background:#f2f1f8;border-radius:8px;padding:12px 14px;"
                f"color:#14121f'>{note}</p>" if note else ""
            )
            + _button(url, "Open timesheet")
        ),
        footer=_alert_footer(manage_url),
    )
    return send(to, f"Timesheet {headline} - {period}", body, html, org_id=org_id)


def send_timesheet_due(
    to: str, name: str, period: str, ends_on: str, url: str, manage_url: str | None = None,
    org_id=None,
) -> bool:
    body = (
        f"Hi {name},\n\n"
        f"Your timesheet for {period} is still a draft and the period closes on "
        f"{ends_on}.\n\nSubmit it: {url}\n"
    )
    html = _WRAPPER.format(
        body=(
            f"<p>Hi {name},</p>"
            f"<p>Your timesheet for <b>{period}</b> is still a draft. "
            f"The period closes on <b>{ends_on}</b>.</p>"
            + _button(url, "Review and submit")
        ),
        footer=_alert_footer(manage_url),
    )
    return send(to, f"Timesheet due - {period}", body, html, org_id=org_id)


def send_approvals_pending(
    to: str, name: str, count: int, period: str, url: str, manage_url: str | None = None,
    org_id=None,
) -> bool:
    noun = "timesheet" if count == 1 else "timesheets"
    body = (
        f"Hi {name},\n\n"
        f"{count} {noun} for {period} are waiting for your review.\n\n{url}\n"
    )
    html = _WRAPPER.format(
        body=(
            f"<p>Hi {name},</p>"
            f"<p><b>{count}</b> {noun} for <b>{period}</b> are waiting for your review.</p>"
            + _button(url, "Review timesheets")
        ),
        footer=_alert_footer(manage_url),
    )
    return send(to, f"{count} {noun} awaiting your approval", body, html, org_id=org_id)


def send_weekly_summary(
    to: str, name: str, period: str, tracked: str, active: str,
    productivity: int, days_worked: int, url: str, manage_url: str | None = None,
    org_id=None,
) -> bool:
    body = (
        f"Hi {name},\n\nYour week, {period}:\n\n"
        f"  Tracked      : {tracked}\n"
        f"  Active       : {active}\n"
        f"  Productivity : {productivity}%\n"
        f"  Days worked  : {days_worked}\n\n"
        f"See the detail: {url}\n"
    )
    row = (
        "<tr><td style='padding:6px 20px 6px 0;color:#55526b'>{k}</td>"
        "<td style='font-weight:650'>{v}</td></tr>"
    )
    html = _WRAPPER.format(
        body=(
            f"<p>Hi {name},</p><p>Your week, <b>{period}</b>.</p>"
            "<table style='border-collapse:collapse;font-size:14px'>"
            + row.format(k="Tracked", v=tracked)
            + row.format(k="Active", v=active)
            + row.format(k="Productivity", v=f"{productivity}%")
            + row.format(k="Days worked", v=days_worked)
            + "</table>"
            + _button(url, "See the detail")
            + "<p style='color:#55526b;font-size:12px'>These are your own figures. "
            "Only you and the people who manage you can see them.</p>"
        ),
        footer=_alert_footer(manage_url),
    )
    return send(to, f"Your week on MyDeskTime - {period}", body, html, org_id=org_id)


def send_billing_attention(
    to: str, org_name: str, headline: str, detail: str, url: str,
    org_id=None,
) -> bool:
    body = f"{headline}\n\n{org_name}: {detail}\n\n{url}\n"
    html = _WRAPPER.format(
        body=(
            f"<p><b>{headline}</b></p><p>{org_name}: {detail}</p>"
            + _button(url, "Open billing")
        ),
        footer="Sent to workspace administrators. Billing alerts cannot be switched off.",
    )
    return send(to, f"{headline} - {org_name}", body, html, org_id=org_id)


def send_capacity_warning(
    to: str, org_name: str, headline: str, detail: str, url: str,
    manage_url: str | None = None,
    org_id=None,
) -> bool:
    body = f"{headline}\n\n{org_name}: {detail}\n\n{url}\n"
    html = _WRAPPER.format(
        body=(
            f"<p><b>{headline}</b></p><p>{org_name}: {detail}</p>"
            + _button(url, "Open MyDeskTime")
        ),
        footer=_alert_footer(manage_url),
    )
    return send(to, f"{headline} - {org_name}", body, html, org_id=org_id)


def send_device_enrolled(
    to: str, name: str, hostname: str, os_name: str, when_local: str, url: str,
    org_id=None,
) -> bool:
    body = (
        f"Hi {name},\n\n"
        f"A device was enrolled against your MyDeskTime account.\n\n"
        f"  Machine : {hostname}\n  System  : {os_name}\n  When    : {when_local}\n\n"
        f"If this was not you, tell your administrator now — your enrolment key "
        f"should be rotated.\n\n{url}\n"
    )
    html = _WRAPPER.format(
        body=(
            f"<p>Hi {name},</p>"
            f"<p>A device was enrolled against your MyDeskTime account.</p>"
            "<table style='border-collapse:collapse;font-size:14px'>"
            f"<tr><td style='padding:4px 20px 4px 0;color:#55526b'>Machine</td>"
            f"<td><b>{hostname}</b></td></tr>"
            f"<tr><td style='padding:4px 20px 4px 0;color:#55526b'>System</td>"
            f"<td>{os_name}</td></tr>"
            f"<tr><td style='padding:4px 20px 4px 0;color:#55526b'>When</td>"
            f"<td>{when_local}</td></tr></table>"
            f"<p style='color:#b06f00'><b>If this was not you</b>, tell your "
            f"administrator now — your enrolment key should be rotated.</p>"
            + _button(url, "Open MyDeskTime")
        ),
        footer="Security notice. This one cannot be switched off.",
    )
    return send(to, "A device was enrolled against your account", body, html, org_id=org_id)
