"""Location pings for employee tracking

Revision ID: t0f4a7c6d38b
Revises: s9e3f6b5c27a
"""

import sqlalchemy as sa
from alembic import op

revision = "t0f4a7c6d38b"
down_revision = "s9e3f6b5c27a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "location_pings",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("org_id", sa.Uuid(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lng", sa.Float(), nullable=False),
        sa.Column("accuracy_m", sa.Float(), nullable=True),
        sa.Column("speed_mps", sa.Float(), nullable=True),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_location_pings_user_time", "location_pings", ["org_id", "user_id", "recorded_at"])


def downgrade() -> None:
    op.drop_index("ix_location_pings_user_time", table_name="location_pings")
    op.drop_table("location_pings")
