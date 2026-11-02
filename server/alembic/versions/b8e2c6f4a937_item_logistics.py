"""item logistics: weight and volume

Revision ID: b8e2c6f4a937
Revises: a3f7d9c2e451
Create Date: 2026-10-29 18:00:00.000000

Per-unit weight (kg) and volume (m³), for freight and dispatch planning.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b8e2c6f4a937'
down_revision: Union[str, None] = 'a3f7d9c2e451'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_items') as batch:
        batch.add_column(sa.Column('weight_kg', sa.Numeric(12, 3), nullable=False, server_default='0'))
        batch.add_column(sa.Column('volume_m3', sa.Numeric(12, 4), nullable=False, server_default='0'))


def downgrade() -> None:
    with op.batch_alter_table('erp_items') as batch:
        batch.drop_column('volume_m3')
        batch.drop_column('weight_kg')
