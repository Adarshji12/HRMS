"""warehouse description

Revision ID: d1a7c3e9f524
Revises: c8f2a4d6e913
Create Date: 2026-10-28 23:00:00.000000

A description on each warehouse. The New warehouse form now asks only for a
name and a description; the code is numbered by the server.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd1a7c3e9f524'
down_revision: Union[str, None] = 'c8f2a4d6e913'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_warehouses') as batch:
        batch.add_column(sa.Column('description', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('erp_warehouses') as batch:
        batch.drop_column('description')
