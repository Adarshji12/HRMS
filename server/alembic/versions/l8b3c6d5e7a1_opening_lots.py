"""ERP opening stock lots

Revision ID: l8b3c6d5e7a1
Revises: k7a2b5c4d6f0
"""

import sqlalchemy as sa
from alembic import op

revision = "l8b3c6d5e7a1"
down_revision = "k7a2b5c4d6f0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "erp_opening_lots",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("warehouse_id", sa.Uuid(), nullable=False),
        sa.Column("lot_no", sa.String(length=40), nullable=False),
        sa.Column("barcode", sa.String(length=64), nullable=True),
        sa.Column("mrp", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("quantity", sa.Numeric(14, 3), nullable=False, server_default="0"),
        sa.Column("pur_rate", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("rate_a", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("rate_b", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("rate_c", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], name=op.f("fk_erp_opening_lots_org_id_organizations"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["item_id"], ["erp_items.id"], name=op.f("fk_erp_opening_lots_item_id_erp_items"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["warehouse_id"], ["erp_warehouses.id"], name=op.f("fk_erp_opening_lots_warehouse_id_erp_warehouses"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_erp_opening_lots")),
        sa.UniqueConstraint("org_id", "item_id", "warehouse_id", "lot_no", name="uq_erp_opening_lots_lot"),
    )
    op.create_index(op.f("ix_erp_opening_lots_org_id"), "erp_opening_lots", ["org_id"])
    op.create_index(op.f("ix_erp_opening_lots_item_id"), "erp_opening_lots", ["item_id"])
    op.create_index(op.f("ix_erp_opening_lots_warehouse_id"), "erp_opening_lots", ["warehouse_id"])


def downgrade() -> None:
    op.drop_table("erp_opening_lots")
