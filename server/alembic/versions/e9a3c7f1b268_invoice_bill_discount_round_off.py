"""invoice bill discount, line discount in rupees, round off

Revision ID: e9a3c7f1b268
Revises: d2b6f8c4e157
Create Date: 2026-10-30 10:00:00.000000

The sale-bill screen: a line's discount may be a percentage or a rupee amount,
a bill discount comes off every item line before GST, and the net amount may
be rounded to the rupee, with the difference kept as round off.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e9a3c7f1b268'
down_revision: Union[str, None] = 'd2b6f8c4e157'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_invoice_lines') as batch:
        batch.add_column(sa.Column('discount_amount', sa.Numeric(14, 2), nullable=False, server_default='0'))
    with op.batch_alter_table('erp_invoices') as batch:
        batch.add_column(sa.Column('bill_discount_percent', sa.Numeric(5, 2), nullable=False, server_default='0'))
        batch.add_column(sa.Column('round_off', sa.Numeric(14, 2), nullable=False, server_default='0'))


def downgrade() -> None:
    with op.batch_alter_table('erp_invoices') as batch:
        batch.drop_column('round_off')
        batch.drop_column('bill_discount_percent')
    with op.batch_alter_table('erp_invoice_lines') as batch:
        batch.drop_column('discount_amount')
