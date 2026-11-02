"""invoice line discount and shipping address

Revision ID: c5d9e1a7b326
Revises: b8e2c6f4a937
Create Date: 2026-10-29 21:00:00.000000

A percentage discount on each invoice line, taken off before GST, and a
shipping address on the invoice beside the billing one.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c5d9e1a7b326'
down_revision: Union[str, None] = 'b8e2c6f4a937'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_invoice_lines') as batch:
        batch.add_column(sa.Column('discount_percent', sa.Numeric(5, 2), nullable=False, server_default='0'))
    with op.batch_alter_table('erp_invoices') as batch:
        batch.add_column(sa.Column('shipping_address', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('erp_invoices') as batch:
        batch.drop_column('shipping_address')
    with op.batch_alter_table('erp_invoice_lines') as batch:
        batch.drop_column('discount_percent')
