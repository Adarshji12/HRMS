"""invoice salesperson, recipient bank, payment reference, delivery date

Revision ID: d2b6f8c4e157
Revises: c5d9e1a7b326
Create Date: 2026-10-29 23:00:00.000000

The company's own bank accounts live on ERP settings; an invoice keeps a copy
of the one the customer is to pay into, so editing the account later does not
rewrite an invoice already sent. "Standard communication" makes the payment
reference the invoice number, filled in when the invoice is posted.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd2b6f8c4e157'
down_revision: Union[str, None] = 'c5d9e1a7b326'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_settings') as batch:
        batch.add_column(sa.Column('bank_accounts', sa.JSON(), nullable=True))
    with op.batch_alter_table('erp_invoices') as batch:
        batch.add_column(sa.Column('salesperson_id', sa.Uuid(), nullable=True))
        batch.add_column(sa.Column('recipient_bank', sa.JSON(), nullable=True))
        batch.add_column(sa.Column('payment_reference', sa.String(60), nullable=True))
        batch.add_column(sa.Column('payment_ref_standard', sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column('delivery_date', sa.Date(), nullable=True))
        batch.create_foreign_key('fk_erp_invoices_salesperson_id_users', 'users', ['salesperson_id'], ['id'],
                                 ondelete='SET NULL')


def downgrade() -> None:
    with op.batch_alter_table('erp_invoices') as batch:
        batch.drop_constraint('fk_erp_invoices_salesperson_id_users', type_='foreignkey')
        for column in ('delivery_date', 'payment_ref_standard', 'payment_reference', 'recipient_bank', 'salesperson_id'):
            batch.drop_column(column)
    with op.batch_alter_table('erp_settings') as batch:
        batch.drop_column('bank_accounts')
