"""Attendance devices: the make / protocol

Revision ID: l2d6e9a8b503
Revises: k1c5d8f7a492

Which push format a biometric machine speaks (generic, ZKTeco, eSSL, Realtime / Matrix /
Mantra). Recorded on the register; nothing receives device punches yet.
"""

import sqlalchemy as sa
from alembic import op

revision = "l2d6e9a8b503"
down_revision = "k1c5d8f7a492"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("attendance_devices") as batch:
        batch.add_column(sa.Column("protocol", sa.String(length=16), nullable=False, server_default="generic"))


def downgrade() -> None:
    with op.batch_alter_table("attendance_devices") as batch:
        batch.drop_column("protocol")
