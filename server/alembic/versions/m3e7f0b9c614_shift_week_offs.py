"""Shifts: full day, break, week offs, colour and a default

Revision ID: m3e7f0b9c614
Revises: l2d6e9a8b503

Everything defaults to what a shift already meant: an eight-hour day with an hour's break,
no week-off pattern of its own (so the work schedule's weekly off still applies), and no
default shift.
"""

import sqlalchemy as sa
from alembic import op

revision = "m3e7f0b9c614"
down_revision = "l2d6e9a8b503"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("shifts") as batch:
        batch.add_column(sa.Column("full_day_minutes", sa.Integer(), nullable=False, server_default="480"))
        batch.add_column(sa.Column("break_minutes", sa.Integer(), nullable=False, server_default="60"))
        batch.add_column(sa.Column("week_offs", sa.Text(), nullable=True))
        batch.add_column(sa.Column("color", sa.String(length=9), nullable=False, server_default="#2563eb"))
        batch.add_column(sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("shifts") as batch:
        for column in ("is_default", "color", "week_offs", "break_minutes", "full_day_minutes"):
            batch.drop_column(column)
