"""invoice cess

Revision ID: d8a4b6e2f195
Revises: c7f3a9d5e284
Create Date: 2026-10-30 17:00:00.000000

GST compensation cess, where a line attracts it: a rate on the line, the cess
it comes to, and the invoice's cess total — charged on the same taxable value
as GST and added to the invoice total.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd8a4b6e2f195'
down_revision: Union[str, None] = 'c7f3a9d5e284'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_invoice_lines') as batch:
        batch.add_column(sa.Column('cess_percent', sa.Numeric(6, 2), nullable=False, server_default='0'))
        batch.add_column(sa.Column('cess_amount', sa.Numeric(14, 2), nullable=False, server_default='0'))
    with op.batch_alter_table('erp_invoices') as batch:
        batch.add_column(sa.Column('cess_total', sa.Numeric(14, 2), nullable=False, server_default='0'))


def downgrade() -> None:
    with op.batch_alter_table('erp_invoices') as batch:
        batch.drop_column('cess_total')
    with op.batch_alter_table('erp_invoice_lines') as batch:
        batch.drop_column('cess_amount')
        batch.drop_column('cess_percent')
