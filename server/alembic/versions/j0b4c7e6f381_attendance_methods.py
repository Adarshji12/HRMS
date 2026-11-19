"""Attendance methods: manual switches and a register of devices

Revision ID: j0b4c7e6f381
Revises: i9a3b6d5e270

Manual attendance (web and mobile check-in) is on by default, which is what every
company already had. Face and biometric are off until switched on, and the device
register records the hardware a company owns; nothing receives device punches yet.
"""

import sqlalchemy as sa
from alembic import op

revision = "j0b4c7e6f381"
down_revision = "i9a3b6d5e270"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("attendance_settings") as batch:
        batch.add_column(sa.Column("manual_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column("manual_web_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column("manual_mobile_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column("face_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("biometric_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))

    op.create_table(
        "attendance_devices",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=12), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("device_code", sa.String(length=80), nullable=True),
        sa.Column("location_id", sa.Uuid(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["location_id"], ["office_locations.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_attendance_devices_org_id", "attendance_devices", ["org_id"])


def downgrade() -> None:
    op.drop_index("ix_attendance_devices_org_id", table_name="attendance_devices")
    op.drop_table("attendance_devices")
    with op.batch_alter_table("attendance_settings") as batch:
        for column in ("biometric_enabled", "face_enabled", "manual_mobile_enabled", "manual_web_enabled", "manual_enabled"):
            batch.drop_column(column)
