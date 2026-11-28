"""ERP: receipt and payment vouchers

Revision ID: a1b7c9d2e4f6
Revises: w9a4c7b6d8f2
"""

import sqlalchemy as sa
from alembic import op

revision = "a1b7c9d2e4f6"
down_revision = "w9a4c7b6d8f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "erp_vouchers",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("org_id", sa.Uuid(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("voucher_type", sa.String(10), nullable=False),
        sa.Column("number", sa.String(32), nullable=False),
        sa.Column("voucher_date", sa.Date(), nullable=False),
        sa.Column("narration", sa.Text(), nullable=True),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("status", sa.String(12), nullable=False, server_default="posted"),
        sa.Column("cancel_reason", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("org_id", "number", name="uq_erp_vouchers_org_number"),
    )
    op.create_index("ix_erp_vouchers_org_id", "erp_vouchers", ["org_id"])
    op.create_index("ix_erp_vouchers_voucher_type", "erp_vouchers", ["voucher_type"])
    op.create_index("ix_erp_vouchers_voucher_date", "erp_vouchers", ["voucher_date"])
    op.create_table(
        "erp_voucher_lines",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("voucher_id", sa.Uuid(), sa.ForeignKey("erp_vouchers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("ledger_id", sa.Uuid(), sa.ForeignKey("erp_ledgers.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("entry", sa.String(2), nullable=False),
        sa.Column("debit", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("credit", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("narration", sa.String(200), nullable=True),
    )
    op.create_index("ix_erp_voucher_lines_voucher_id", "erp_voucher_lines", ["voucher_id"])
    op.create_index("ix_erp_voucher_lines_ledger_id", "erp_voucher_lines", ["ledger_id"])


def downgrade() -> None:
    op.drop_table("erp_voucher_lines")
    op.drop_table("erp_vouchers")
