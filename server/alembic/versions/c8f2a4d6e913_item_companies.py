"""item companies

Revision ID: c8f2a4d6e913
Revises: b6e1f3a8c429
Create Date: 2026-10-28 22:00:00.000000

A Companies list on the ERP Master card -- the makes / OEMs whose products are
stocked. The item form picks its make from it; items keep storing the name.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c8f2a4d6e913'
down_revision: Union[str, None] = 'b6e1f3a8c429'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'crm_item_companies',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('name', sa.String(length=80), nullable=False),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('org_id', 'name', name='uq_crm_item_companies_org_name'),
    )
    op.create_index('ix_crm_item_companies_org_id', 'crm_item_companies', ['org_id'])


def downgrade() -> None:
    op.drop_index('ix_crm_item_companies_org_id', table_name='crm_item_companies')
    op.drop_table('crm_item_companies')
