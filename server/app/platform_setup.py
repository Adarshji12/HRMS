"""Bootstrap the Super Admin account.

    python -m app.platform_setup                      # generate a password
    python -m app.platform_setup --email ops@you.com  # choose the address
    python -m app.platform_setup --reset-password     # rotate an existing one

The generated password is printed once and never stored in plain text. The
account is created with ``must_change_password`` set, so it can sign in and look
around but cannot change anything until the password is replaced — a deployment
therefore cannot be left running on credentials that appear in documentation.
"""

from __future__ import annotations

import argparse
import secrets
import string

from sqlalchemy import func, select

from app.core.security import generate_password, hash_password
from app.db.migrations import upgrade_to_head
from app.db.session import SessionLocal
from app.models import PlatformAdmin

DEFAULT_EMAIL = "superadmin@mydesktime.local"


def main() -> None:
    parser = argparse.ArgumentParser(description="Create or reset the Super Admin account")
    parser.add_argument("--email", default=DEFAULT_EMAIL)
    parser.add_argument("--name", default="Platform Administrator")
    parser.add_argument("--password", help="use this instead of a generated one")
    parser.add_argument("--reset-password", action="store_true",
                        help="rotate the password of an existing account")
    args = parser.parse_args()

    upgrade_to_head()
    email = args.email.strip().lower()
    password = args.password or generate_password()

    with SessionLocal() as db:
        existing = db.scalar(select(PlatformAdmin).where(PlatformAdmin.email == email))

        if existing is not None and not args.reset_password:
            total = db.scalar(select(func.count(PlatformAdmin.id)))
            print(f"\nSuper Admin {email} already exists ({total} platform account(s)).")
            print("Use --reset-password to set a new password.\n")
            return

        if existing is not None:
            existing.password_hash = hash_password(password)
            existing.must_change_password = True
            existing.is_active = True
            action = "reset"
        else:
            db.add(
                PlatformAdmin(
                    email=email,
                    full_name=args.name,
                    password_hash=hash_password(password),
                    must_change_password=True,
                )
            )
            action = "created"
        db.commit()

    print("\n" + "=" * 68)
    print(f"  SUPER ADMIN {action.upper()}")
    print("=" * 68)
    print(f"  Email    : {email}")
    print(f"  Password : {password}")
    print("=" * 68)
    print("  Shown once. Store it in a password manager now.")
    print("  Sign-in works immediately, but every change is blocked until this")
    print("  password is replaced via POST /api/v1/platform/auth/change-password.")
    print("=" * 68 + "\n")


if __name__ == "__main__":
    main()
