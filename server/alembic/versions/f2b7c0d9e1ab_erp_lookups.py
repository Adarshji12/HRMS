"""ERP inventory lookups

Revision ID: f2b7c0d9e1ab
Revises: e1a6b9c8d0fa
"""

import sqlalchemy as sa
from alembic import op

revision = "f2b7c0d9e1ab"
down_revision = "e1a6b9c8d0fa"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "erp_lookups",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.String(length=240), nullable=True),
        sa.Column("parent_name", sa.String(length=120), nullable=True),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], name=op.f("fk_erp_lookups_org_id_organizations"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_erp_lookups")),
        sa.UniqueConstraint("org_id", "kind", "name", name="uq_erp_lookups_org_kind_name"),
    )
    op.create_index(op.f("ix_erp_lookups_org_id"), "erp_lookups", ["org_id"])
    op.create_index(op.f("ix_erp_lookups_kind"), "erp_lookups", ["kind"])


def downgrade() -> None:
    op.drop_index(op.f("ix_erp_lookups_kind"), table_name="erp_lookups")
    op.drop_index(op.f("ix_erp_lookups_org_id"), table_name="erp_lookups")
    op.drop_table("erp_lookups")
