"""RFQ: the fields a buyer sends and a vendor answers with.

Revision ID: f2a9c4e7b318
Revises: d3b8f1c6a457
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f2a9c4e7b318"
down_revision: Union[str, None] = "d3b8f1c6a457"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("erp_rfqs", schema=None) as batch_op:
        batch_op.add_column(sa.Column("rfq_date", sa.Date(), nullable=True))
        batch_op.add_column(sa.Column("required_by", sa.Date(), nullable=True))
        batch_op.add_column(sa.Column("warehouse_id", sa.Uuid(), nullable=True))
        batch_op.add_column(sa.Column("payment_terms", sa.String(160), nullable=True))
        batch_op.add_column(sa.Column("delivery_terms", sa.String(160), nullable=True))
        batch_op.add_column(sa.Column("quote_validity_days", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("contact_person", sa.String(120), nullable=True))
        batch_op.add_column(sa.Column("notes", sa.Text(), nullable=True))
        batch_op.create_foreign_key("fk_erp_rfqs_warehouse_id", "erp_warehouses", ["warehouse_id"], ["id"], ondelete="SET NULL")
    with op.batch_alter_table("erp_rfq_lines", schema=None) as batch_op:
        batch_op.add_column(sa.Column("specification", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("target_rate", sa.Numeric(14, 2), nullable=True))
    with op.batch_alter_table("erp_vendor_quotes", schema=None) as batch_op:
        batch_op.add_column(sa.Column("quote_date", sa.Date(), nullable=True))
    with op.batch_alter_table("erp_vendor_quote_lines", schema=None) as batch_op:
        batch_op.add_column(sa.Column("discount_percent", sa.Numeric(5, 2), nullable=False, server_default="0"))
        batch_op.add_column(sa.Column("make", sa.String(120), nullable=True))
    # An RFQ raised before this is dated the day it was made.
    op.execute("UPDATE erp_rfqs SET rfq_date = DATE(created_at) WHERE rfq_date IS NULL")


def downgrade() -> None:
    with op.batch_alter_table("erp_vendor_quote_lines", schema=None) as batch_op:
        batch_op.drop_column("make")
        batch_op.drop_column("discount_percent")
    with op.batch_alter_table("erp_vendor_quotes", schema=None) as batch_op:
        batch_op.drop_column("quote_date")
    with op.batch_alter_table("erp_rfq_lines", schema=None) as batch_op:
        batch_op.drop_column("target_rate")
        batch_op.drop_column("specification")
    with op.batch_alter_table("erp_rfqs", schema=None) as batch_op:
        batch_op.drop_constraint("fk_erp_rfqs_warehouse_id", type_="foreignkey")
        for col in ("notes", "contact_person", "quote_validity_days", "delivery_terms", "payment_terms",
                    "warehouse_id", "required_by", "rfq_date"):
            batch_op.drop_column(col)
