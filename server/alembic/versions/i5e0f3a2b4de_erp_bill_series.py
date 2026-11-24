"""ERP bill series

Revision ID: i5e0f3a2b4de
Revises: h4d9e2f1a3cd
"""

import sqlalchemy as sa
from alembic import op

revision = "i5e0f3a2b4de"
down_revision = "h4d9e2f1a3cd"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "erp_bill_series",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("transaction", sa.String(length=24), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("used_for", sa.String(length=200), nullable=True),
        sa.Column("prefix", sa.String(length=20), nullable=False, server_default=""),
        sa.Column("suffix", sa.String(length=20), nullable=False, server_default=""),
        sa.Column("digits", sa.Integer(), nullable=False, server_default="4"),
        sa.Column("restart", sa.String(length=8), nullable=False, server_default="april"),
        sa.Column("next_number", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("issued", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("applicable_from", sa.Date(), nullable=True),
        sa.Column("print_title", sa.String(length=120), nullable=True),
        sa.Column("default_groups", sa.JSON(), nullable=True),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], name=op.f("fk_erp_bill_series_org_id_organizations"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_erp_bill_series")),
        sa.UniqueConstraint("org_id", "transaction", "name", name="uq_erp_bill_series_org_txn_name"),
    )
    op.create_index(op.f("ix_erp_bill_series_org_id"), "erp_bill_series", ["org_id"])
    op.create_index(op.f("ix_erp_bill_series_transaction"), "erp_bill_series", ["transaction"])


def downgrade() -> None:
    op.drop_index(op.f("ix_erp_bill_series_transaction"), table_name="erp_bill_series")
    op.drop_index(op.f("ix_erp_bill_series_org_id"), table_name="erp_bill_series")
    op.drop_table("erp_bill_series")
