"""CRM access: who sees every lead and every customer, and who may hand them out

Revision ID: d4a7b1c9e268
Revises: c9f2a6d8e153

One row per person who has been given an explicit setting on Settings > Access.
A person without a row keeps what they had: the scope their role and reporting
line already gave them. Nothing existing changes until somebody is edited.
"""

import sqlalchemy as sa
from alembic import op

revision = "d4a7b1c9e268"
down_revision = "c9f2a6d8e153"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "crm_access",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("lead_scope", sa.String(length=12), nullable=True),
        sa.Column("customer_scope", sa.String(length=12), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", name="uq_crm_access_user"),
    )
    op.create_index("ix_crm_access_org_id", "crm_access", ["org_id"])


def downgrade() -> None:
    op.drop_index("ix_crm_access_org_id", table_name="crm_access")
    op.drop_table("crm_access")
