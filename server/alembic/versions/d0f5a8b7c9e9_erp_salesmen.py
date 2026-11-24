"""ERP salesmen

Revision ID: d0f5a8b7c9e9
Revises: c8d3e6f5a7c7
"""

import sqlalchemy as sa
from alembic import op

revision = "d0f5a8b7c9e9"
down_revision = "c8d3e6f5a7c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "erp_salesmen",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("code", sa.String(length=24), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("mobile", sa.String(length=24), nullable=True),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("area_beat", sa.String(length=160), nullable=True),
        sa.Column("commission_pct", sa.Numeric(5, 2), nullable=False, server_default="0"),
        sa.Column("monthly_target", sa.Numeric(14, 2), nullable=True),
        sa.Column("allow_login", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], name=op.f("fk_erp_salesmen_org_id_organizations"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_erp_salesmen")),
        sa.UniqueConstraint("org_id", "code", name="uq_erp_salesmen_org_code"),
    )
    op.create_index(op.f("ix_erp_salesmen_org_id"), "erp_salesmen", ["org_id"])
    op.create_index(op.f("ix_erp_salesmen_name"), "erp_salesmen", ["name"])


def downgrade() -> None:
    op.drop_index(op.f("ix_erp_salesmen_name"), table_name="erp_salesmen")
    op.drop_index(op.f("ix_erp_salesmen_org_id"), table_name="erp_salesmen")
    op.drop_table("erp_salesmen")
