"""item profile: image, barcode, tags, sold / purchased, track inventory

Revision ID: e7c4b2f9a618
Revises: d1a7c3e9f524
Create Date: 2026-10-29 12:00:00.000000

What a product form usually carries that the item did not: a picture, a
barcode, free tags, a favourite mark, whether it can be sold and bought, and
whether stock is tracked at all (goods that are expensed on purchase).
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e7c4b2f9a618'
down_revision: Union[str, None] = 'd1a7c3e9f524'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_items') as batch:
        batch.add_column(sa.Column('image', sa.Text(), nullable=True))
        batch.add_column(sa.Column('barcode', sa.String(64), nullable=True))
        batch.add_column(sa.Column('tags', sa.JSON(), nullable=True))
        batch.add_column(sa.Column('is_favorite', sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column('can_be_sold', sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column('can_be_purchased', sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column('track_inventory', sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    with op.batch_alter_table('erp_items') as batch:
        for column in ('track_inventory', 'can_be_purchased', 'can_be_sold', 'is_favorite', 'tags', 'barcode', 'image'):
            batch.drop_column(column)
