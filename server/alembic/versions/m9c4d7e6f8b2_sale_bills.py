"""ERP sale bills (ledger-based)

Revision ID: m9c4d7e6f8b2
Revises: l8b3c6d5e7a1
"""

import sqlalchemy as sa
from alembic import op

revision = "m9c4d7e6f8b2"
down_revision = "l8b3c6d5e7a1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "erp_sale_bills",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("number", sa.String(length=32), nullable=False),
        sa.Column("bill_date", sa.Date(), nullable=False),
        sa.Column("bill_type", sa.String(length=8), nullable=False, server_default="credit"),
        sa.Column("ledger_id", sa.Uuid(), nullable=True),
        sa.Column("walkin_id", sa.Uuid(), nullable=True),
        sa.Column("party_name", sa.String(length=160), nullable=False),
        sa.Column("warehouse_id", sa.Uuid(), nullable=True),
        sa.Column("sub_total", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("discount_total", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("tax_total", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("grand_total", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], name=op.f("fk_erp_sale_bills_org_id_organizations"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["ledger_id"], ["erp_ledgers.id"], name=op.f("fk_erp_sale_bills_ledger_id_erp_ledgers"), ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["walkin_id"], ["erp_walkin_customers.id"], name=op.f("fk_erp_sale_bills_walkin_id_erp_walkin_customers"), ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["warehouse_id"], ["erp_warehouses.id"], name=op.f("fk_erp_sale_bills_warehouse_id_erp_warehouses"), ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], name=op.f("fk_erp_sale_bills_created_by_users"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_erp_sale_bills")),
        sa.UniqueConstraint("org_id", "number", name="uq_erp_sale_bills_org_number"),
    )
    op.create_index(op.f("ix_erp_sale_bills_org_id"), "erp_sale_bills", ["org_id"])
    op.create_index(op.f("ix_erp_sale_bills_bill_date"), "erp_sale_bills", ["bill_date"])
    op.create_index(op.f("ix_erp_sale_bills_ledger_id"), "erp_sale_bills", ["ledger_id"])
    op.create_index(op.f("ix_erp_sale_bills_walkin_id"), "erp_sale_bills", ["walkin_id"])
    op.create_table(
        "erp_sale_bill_lines",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("bill_id", sa.Uuid(), nullable=False),
        sa.Column("line_no", sa.Integer(), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=True),
        sa.Column("description", sa.String(length=300), nullable=False),
        sa.Column("lot_no", sa.String(length=40), nullable=True),
        sa.Column("quantity", sa.Numeric(14, 3), nullable=False),
        sa.Column("free_qty", sa.Numeric(14, 3), nullable=False, server_default="0"),
        sa.Column("uom", sa.String(length=16), nullable=True),
        sa.Column("mrp", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("rate", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("discount_percent", sa.Numeric(5, 2), nullable=False, server_default="0"),
        sa.Column("discount_amount", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("gst_percent", sa.Numeric(5, 2), nullable=False, server_default="0"),
        sa.Column("taxable", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("tax", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], name=op.f("fk_erp_sale_bill_lines_org_id_organizations"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["bill_id"], ["erp_sale_bills.id"], name=op.f("fk_erp_sale_bill_lines_bill_id_erp_sale_bills"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["item_id"], ["erp_items.id"], name=op.f("fk_erp_sale_bill_lines_item_id_erp_items"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_erp_sale_bill_lines")),
    )
    op.create_index(op.f("ix_erp_sale_bill_lines_org_id"), "erp_sale_bill_lines", ["org_id"])
    op.create_index(op.f("ix_erp_sale_bill_lines_bill_id"), "erp_sale_bill_lines", ["bill_id"])


def downgrade() -> None:
    op.drop_table("erp_sale_bill_lines")
    op.drop_table("erp_sale_bills")
