"""receipt: deposit account, payment proof and a correction log

Revision ID: d5a9e3b7f621
Revises: c4f8a2d6e517
Create Date: 2026-11-01 11:00:00.000000

Which of the company's accounts the money went into (a snapshot of its label,
so renaming the account later does not rewrite history), the proof the payer
sent, and every later correction of a receipt's details with who, when, why.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd5a9e3b7f621'
down_revision: Union[str, None] = 'c4f8a2d6e517'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_receipts') as batch:
        batch.add_column(sa.Column('deposit_account_id', sa.String(length=40), nullable=True))
        batch.add_column(sa.Column('deposit_account', sa.String(length=200), nullable=True))
        batch.add_column(sa.Column('proof', sa.Text(), nullable=True))
        batch.add_column(sa.Column('proof_name', sa.String(length=160), nullable=True))
        batch.add_column(sa.Column('corrections', sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('erp_receipts') as batch:
        for name in ('corrections', 'proof_name', 'proof', 'deposit_account', 'deposit_account_id'):
            batch.drop_column(name)
