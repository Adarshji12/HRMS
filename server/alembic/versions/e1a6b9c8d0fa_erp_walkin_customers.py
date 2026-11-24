"""ERP walk-in customers

Revision ID: e1a6b9c8d0fa
Revises: d0f5a8b7c9e9
"""

import sqlalchemy as sa
from alembic import op

revision = "e1a6b9c8d0fa"
down_revision = "d0f5a8b7c9e9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "erp_walkin_customers",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("mobile", sa.String(length=24), nullable=True),
        sa.Column("whatsapp", sa.String(length=24), nullable=True),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("dob", sa.Date(), nullable=True),
        sa.Column("anniversary", sa.Date(), nullable=True),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], name=op.f("fk_erp_walkin_customers_org_id_organizations"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], name=op.f("fk_erp_walkin_customers_created_by_users"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_erp_walkin_customers")),
    )
    op.create_index(op.f("ix_erp_walkin_customers_org_id"), "erp_walkin_customers", ["org_id"])
    op.create_index(op.f("ix_erp_walkin_customers_name"), "erp_walkin_customers", ["name"])
    op.create_index(op.f("ix_erp_walkin_customers_mobile"), "erp_walkin_customers", ["mobile"])


def downgrade() -> None:
    op.drop_index(op.f("ix_erp_walkin_customers_mobile"), table_name="erp_walkin_customers")
    op.drop_index(op.f("ix_erp_walkin_customers_name"), table_name="erp_walkin_customers")
    op.drop_index(op.f("ix_erp_walkin_customers_org_id"), table_name="erp_walkin_customers")
    op.drop_table("erp_walkin_customers")
