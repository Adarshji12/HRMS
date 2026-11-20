"""Company notification rules (email events) and the other HR alerts

Revision ID: s9e3f6b5c27a
Revises: r8d2e5a4b169
"""

import sqlalchemy as sa
from alembic import op

revision = "s9e3f6b5c27a"
down_revision = "r8d2e5a4b169"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notification_rules",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("org_id", sa.Uuid(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("event", sa.String(40), nullable=False),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("subject", sa.String(300), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("org_id", "event", name="uq_notification_rules_event"),
    )
    op.create_table(
        "notification_org_settings",
        sa.Column("org_id", sa.Uuid(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("probation_alert", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("document_alert", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("notification_org_settings")
    op.drop_table("notification_rules")
