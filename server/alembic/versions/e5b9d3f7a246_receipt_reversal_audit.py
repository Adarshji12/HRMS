"""receipt reversal audit: who reversed it, when

Revision ID: e5b9d3f7a246
Revises: d8a4b6e2f195
Create Date: 2026-10-30 19:00:00.000000

A reversed receipt already keeps its reason; it now keeps who reversed it and
when, so a payment's history reads in full on the invoice itself.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e5b9d3f7a246'
down_revision: Union[str, None] = 'd8a4b6e2f195'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_receipts') as batch:
        batch.add_column(sa.Column('reversed_at', sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column('reversed_by', sa.Uuid(), nullable=True))
        batch.create_foreign_key('fk_erp_receipts_reversed_by_users', 'users', ['reversed_by'], ['id'], ondelete='SET NULL')


def downgrade() -> None:
    with op.batch_alter_table('erp_receipts') as batch:
        batch.drop_constraint('fk_erp_receipts_reversed_by_users', type_='foreignkey')
        batch.drop_column('reversed_by')
        batch.drop_column('reversed_at')
