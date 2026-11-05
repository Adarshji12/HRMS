"""Purchase order: the vendor's quotation, who to contact, where to bill, attachments and line delivery dates.

Revision ID: e4b7c2f8a615
Revises: c7d1e4a9f302

All nullable: an order raised before these existed simply has none of them.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e4b7c2f8a615"
down_revision: Union[str, None] = "c7d1e4a9f302"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("erp_purchase_orders", schema=None) as batch_op:
        batch_op.add_column(sa.Column("vendor_quote_ref", sa.String(length=80), nullable=True))
        batch_op.add_column(sa.Column("vendor_quote_date", sa.Date(), nullable=True))
        batch_op.add_column(sa.Column("contact_person", sa.String(length=120), nullable=True))
        batch_op.add_column(sa.Column("billing_address", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("attachments", sa.JSON(), nullable=True))
    with op.batch_alter_table("erp_purchase_order_lines", schema=None) as batch_op:
        batch_op.add_column(sa.Column("expected_date", sa.Date(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("erp_purchase_order_lines", schema=None) as batch_op:
        batch_op.drop_column("expected_date")
    with op.batch_alter_table("erp_purchase_orders", schema=None) as batch_op:
        batch_op.drop_column("attachments")
        batch_op.drop_column("billing_address")
        batch_op.drop_column("contact_person")
        batch_op.drop_column("vendor_quote_date")
        batch_op.drop_column("vendor_quote_ref")
