"""Attendance: company switch for GPS tracking

Revision ID: t6d1f4e3a5c9
Revises: s5c0e3d2f4b8
"""

import sqlalchemy as sa
from alembic import op

revision = "t6d1f4e3a5c9"
down_revision = "s5c0e3d2f4b8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("attendance_settings") as batch:
        batch.add_column(sa.Column("gps_tracking_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    with op.batch_alter_table("attendance_settings") as batch:
        batch.drop_column("gps_tracking_enabled")
