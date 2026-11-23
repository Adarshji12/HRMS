"""ERP account groups

Revision ID: a6b1c4d3e5a5
Revises: z5f0a3c2d494
"""

import sqlalchemy as sa
from alembic import op

revision = "a6b1c4d3e5a5"
down_revision = "z5f0a3c2d494"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "erp_account_groups",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], name=op.f("fk_erp_account_groups_org_id_organizations"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["parent_id"], ["erp_account_groups.id"], name=op.f("fk_erp_account_groups_parent_id_erp_account_groups"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_erp_account_groups")),
        sa.UniqueConstraint("org_id", "name", name="uq_erp_account_groups_org_name"),
    )
    op.create_index(op.f("ix_erp_account_groups_org_id"), "erp_account_groups", ["org_id"])
    op.create_index(op.f("ix_erp_account_groups_parent_id"), "erp_account_groups", ["parent_id"])


def downgrade() -> None:
    op.drop_index(op.f("ix_erp_account_groups_parent_id"), table_name="erp_account_groups")
    op.drop_index(op.f("ix_erp_account_groups_org_id"), table_name="erp_account_groups")
    op.drop_table("erp_account_groups")
