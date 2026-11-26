"""Helpdesk SLA

Revision ID: s5c0e3d2f4b8
Revises: r4b9d2c1e3a7
"""

import sqlalchemy as sa
from alembic import op

revision = "s5c0e3d2f4b8"
down_revision = "r4b9d2c1e3a7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "helpdesk_sla",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("org_id", sa.Uuid(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("priority", sa.String(length=20), nullable=False),
        sa.Column("respond_minutes", sa.Integer(), nullable=False),
        sa.Column("resolve_minutes", sa.Integer(), nullable=False),
        sa.UniqueConstraint("org_id", "priority", name="uq_helpdesk_sla_org_priority"),
    )
    op.create_index("ix_helpdesk_sla_org_id", "helpdesk_sla", ["org_id"])
    with op.batch_alter_table("helpdesk_tickets") as batch:
        batch.add_column(sa.Column("respond_by", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("resolve_by", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("first_response_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("helpdesk_tickets") as batch:
        batch.drop_column("first_response_at")
        batch.drop_column("resolve_by")
        batch.drop_column("respond_by")
    op.drop_index("ix_helpdesk_sla_org_id", table_name="helpdesk_sla")
    op.drop_table("helpdesk_sla")
