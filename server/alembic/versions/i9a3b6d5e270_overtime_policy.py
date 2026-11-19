"""Attendance: an overtime policy

Revision ID: i9a3b6d5e270
Revises: h8f2a5c4d169

Three columns with defaults equal to the behaviour timesheets already had, so nothing
changes for a company until somebody edits the policy: overtime counts, from the first
extra minute, and work on a day off counts whole.
"""

import sqlalchemy as sa
from alembic import op

revision = "i9a3b6d5e270"
down_revision = "h8f2a5c4d169"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("attendance_settings") as batch:
        batch.add_column(sa.Column("overtime_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column("overtime_min_minutes", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("overtime_on_off_days", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    with op.batch_alter_table("attendance_settings") as batch:
        batch.drop_column("overtime_on_off_days")
        batch.drop_column("overtime_min_minutes")
        batch.drop_column("overtime_enabled")
