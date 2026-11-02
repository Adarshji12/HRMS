"""quotation letter

Revision ID: a4d9e2c7f816
Revises: f2c8a5d1b934
Create Date: 2026-10-28 18:00:00.000000

The style each quotation was raised in, and the Detailed / Proposal fields it
carries: subject, covering letter, payment, delivery and warranty terms. Every
existing quotation is a simple one, which is what they all were.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a4d9e2c7f816'
down_revision: Union[str, None] = 'f2c8a5d1b934'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('crm_quotations') as batch:
        batch.add_column(sa.Column('style', sa.String(length=16), nullable=False, server_default='simple'))
        batch.add_column(sa.Column('subject', sa.String(length=200), nullable=True))
        batch.add_column(sa.Column('letter_body', sa.Text(), nullable=True))
        batch.add_column(sa.Column('payment_terms', sa.Text(), nullable=True))
        batch.add_column(sa.Column('delivery_terms', sa.Text(), nullable=True))
        batch.add_column(sa.Column('warranty_terms', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('crm_quotations') as batch:
        for name in ('warranty_terms', 'delivery_terms', 'payment_terms', 'letter_body', 'subject', 'style'):
            batch.drop_column(name)
