"""Attendance devices: branch, verification and timing

Revision ID: k1c5d8f7a492
Revises: j0b4c7e6f381

A device can say which branch it belongs to, require the punch to be inside a radius
and/or from an allowed network, and set a cooldown and the window around a shift in
which it accepts a scan. Recorded on the register; nothing receives device punches yet.
"""

import sqlalchemy as sa
from alembic import op

revision = "k1c5d8f7a492"
down_revision = "j0b4c7e6f381"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("attendance_devices") as batch:
        batch.add_column(sa.Column("branch_id", sa.Uuid(), nullable=True))
        batch.add_column(sa.Column("location_required", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("lat", sa.Float(), nullable=True))
        batch.add_column(sa.Column("lng", sa.Float(), nullable=True))
        batch.add_column(sa.Column("radius_m", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("ip_required", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("allowed_ips", sa.Text(), nullable=True))
        batch.add_column(sa.Column("cooldown_s", sa.Integer(), nullable=False, server_default="120"))
        batch.add_column(sa.Column("allowed_from_min", sa.Integer(), nullable=False, server_default="120"))
        batch.add_column(sa.Column("allowed_until_min", sa.Integer(), nullable=False, server_default="240"))
        batch.create_foreign_key("fk_attendance_devices_branch", "branches", ["branch_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    with op.batch_alter_table("attendance_devices") as batch:
        batch.drop_constraint("fk_attendance_devices_branch", type_="foreignkey")
        for column in ("allowed_until_min", "allowed_from_min", "cooldown_s", "allowed_ips", "ip_required",
                       "radius_m", "lng", "lat", "location_required", "branch_id"):
            batch.drop_column(column)
