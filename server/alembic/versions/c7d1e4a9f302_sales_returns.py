"""Goods a customer sends back against a dispatch.

Revision ID: c7d1e4a9f302
Revises: a6e2d8c4f071
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c7d1e4a9f302"
down_revision: Union[str, None] = "a6e2d8c4f071"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("erp_dispatch_lines", schema=None) as batch_op:
        batch_op.add_column(sa.Column("returned_qty", sa.Numeric(14, 3), nullable=False, server_default="0"))

    op.create_table(
        "erp_sales_returns",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("number", sa.String(length=32), nullable=False),
        sa.Column("sales_order_id", sa.Uuid(), nullable=False),
        sa.Column("dispatch_id", sa.Uuid(), nullable=False),
        sa.Column("warehouse_id", sa.Uuid(), nullable=False),
        sa.Column("return_date", sa.Date(), nullable=False),
        sa.Column("condition", sa.String(length=12), nullable=False, server_default="good"),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("lines", sa.JSON(), nullable=False),
        sa.Column("value", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["sales_order_id"], ["erp_sales_orders.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["dispatch_id"], ["erp_dispatches.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["warehouse_id"], ["erp_warehouses.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "number", name="uq_erp_sales_returns_org_number"),
    )
    op.create_index("ix_erp_sales_returns_org_id", "erp_sales_returns", ["org_id"])
    op.create_index("ix_erp_sales_returns_sales_order_id", "erp_sales_returns", ["sales_order_id"])
    op.create_index("ix_erp_sales_returns_dispatch_id", "erp_sales_returns", ["dispatch_id"])


def downgrade() -> None:
    op.drop_table("erp_sales_returns")
    with op.batch_alter_table("erp_dispatch_lines", schema=None) as batch_op:
        batch_op.drop_column("returned_qty")
