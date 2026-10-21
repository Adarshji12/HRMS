"""crm sales masters

Revision ID: bd365c1a2ac6
Revises: 18c7b109fbe7
Create Date: 2026-10-20 11:09:59.469331
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'bd365c1a2ac6'
down_revision: Union[str, None] = '18c7b109fbe7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('crm_competitors',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=160), nullable=False),
    sa.Column('website', sa.String(length=200), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_competitors_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_competitors')),
    sa.UniqueConstraint('org_id', 'name', name='uq_crm_competitors_org_name')
    )
    with op.batch_alter_table('crm_competitors', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_competitors_org_id'), ['org_id'], unique=False)

    op.create_table('crm_contact_designations',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('sort_order', sa.Integer(), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_contact_designations_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_contact_designations')),
    sa.UniqueConstraint('org_id', 'name', name='uq_crm_contact_designations_org_name')
    )
    with op.batch_alter_table('crm_contact_designations', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_contact_designations_org_id'), ['org_id'], unique=False)

    op.create_table('crm_lost_reasons',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('outcome', sa.String(length=20), nullable=False),
    sa.Column('requires_competitor', sa.Boolean(), nullable=False),
    sa.Column('sort_order', sa.Integer(), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_lost_reasons_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_lost_reasons')),
    sa.UniqueConstraint('org_id', 'name', name='uq_crm_lost_reasons_org_name')
    )
    with op.batch_alter_table('crm_lost_reasons', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_lost_reasons_org_id'), ['org_id'], unique=False)

    op.create_table('crm_opportunity_stages',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('behaviour', sa.String(length=20), nullable=False),
    sa.Column('probability', sa.Integer(), nullable=False),
    sa.Column('forecast_category', sa.String(length=20), nullable=True),
    sa.Column('stale_after_days', sa.Integer(), nullable=False),
    sa.Column('colour', sa.String(length=9), nullable=False),
    sa.Column('sort_order', sa.Integer(), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_opportunity_stages_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_opportunity_stages')),
    sa.UniqueConstraint('org_id', 'name', name='uq_crm_opportunity_stages_org_name')
    )
    with op.batch_alter_table('crm_opportunity_stages', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_opportunity_stages_org_id'), ['org_id'], unique=False)
        batch_op.create_index('ix_crm_opportunity_stages_org_sort', ['org_id', 'sort_order'], unique=False)

    op.create_table('crm_campaigns',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=160), nullable=False),
    sa.Column('source_id', sa.Uuid(), nullable=True),
    sa.Column('starts_on', sa.Date(), nullable=True),
    sa.Column('ends_on', sa.Date(), nullable=True),
    sa.Column('budget', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_campaigns_org_id_organizations'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['source_id'], ['crm_lead_sources.id'], name=op.f('fk_crm_campaigns_source_id_crm_lead_sources'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_campaigns')),
    sa.UniqueConstraint('org_id', 'name', name='uq_crm_campaigns_org_name')
    )
    with op.batch_alter_table('crm_campaigns', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_campaigns_org_id'), ['org_id'], unique=False)

    op.create_table('crm_territories',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('code', sa.String(length=20), nullable=True),
    sa.Column('state_ids', sa.JSON(), nullable=False),
    sa.Column('manager_id', sa.Uuid(), nullable=True),
    sa.Column('sort_order', sa.Integer(), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['manager_id'], ['users.id'], name=op.f('fk_crm_territories_manager_id_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_territories_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_territories')),
    sa.UniqueConstraint('org_id', 'name', name='uq_crm_territories_org_name')
    )
    with op.batch_alter_table('crm_territories', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_territories_org_id'), ['org_id'], unique=False)

    with op.batch_alter_table('crm_products', schema=None) as batch_op:
        batch_op.add_column(sa.Column('category', sa.String(length=20), server_default='product', nullable=False))
        batch_op.add_column(sa.Column('oem', sa.String(length=120), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('crm_products', schema=None) as batch_op:
        batch_op.drop_column('oem')
        batch_op.drop_column('category')

    with op.batch_alter_table('crm_territories', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_crm_territories_org_id'))

    op.drop_table('crm_territories')
    with op.batch_alter_table('crm_campaigns', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_crm_campaigns_org_id'))

    op.drop_table('crm_campaigns')
    with op.batch_alter_table('crm_opportunity_stages', schema=None) as batch_op:
        batch_op.drop_index('ix_crm_opportunity_stages_org_sort')
        batch_op.drop_index(batch_op.f('ix_crm_opportunity_stages_org_id'))

    op.drop_table('crm_opportunity_stages')
    with op.batch_alter_table('crm_lost_reasons', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_crm_lost_reasons_org_id'))

    op.drop_table('crm_lost_reasons')
    with op.batch_alter_table('crm_contact_designations', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_crm_contact_designations_org_id'))

    op.drop_table('crm_contact_designations')
    with op.batch_alter_table('crm_competitors', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_crm_competitors_org_id'))

    op.drop_table('crm_competitors')
    # ### end Alembic commands ###
