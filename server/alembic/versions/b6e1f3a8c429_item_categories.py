"""item categories

Revision ID: b6e1f3a8c429
Revises: a4d9e2c7f816
Create Date: 2026-10-28 20:00:00.000000

An Item Categories list on the ERP Master card, which the item form picks its
category from. Items keep storing the category as text, so nothing existing
moves.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b6e1f3a8c429'
down_revision: Union[str, None] = 'a4d9e2c7f816'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'crm_item_categories',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('name', sa.String(length=80), nullable=False),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('org_id', 'name', name='uq_crm_item_categories_org_name'),
    )
    op.create_index('ix_crm_item_categories_org_id', 'crm_item_categories', ['org_id'])


def downgrade() -> None:
    op.drop_index('ix_crm_item_categories_org_id', table_name='crm_item_categories')
    op.drop_table('crm_item_categories')
