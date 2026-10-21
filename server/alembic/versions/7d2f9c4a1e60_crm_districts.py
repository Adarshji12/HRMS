"""crm districts

Revision ID: 7d2f9c4a1e60
Revises: c4e7a2b91d30
Create Date: 2026-10-20 12:10:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '7d2f9c4a1e60'
down_revision: Union[str, None] = 'c4e7a2b91d30'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('crm_districts',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('state_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_districts_org_id_organizations'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['state_id'], ['crm_states.id'], name=op.f('fk_crm_districts_state_id_crm_states'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_districts')),
    sa.UniqueConstraint('org_id', 'state_id', 'name', name='uq_crm_districts_org_state_name')
    )
    with op.batch_alter_table('crm_districts', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_districts_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_districts_state_id'), ['state_id'], unique=False)

    with op.batch_alter_table('crm_cities', schema=None) as batch_op:
        batch_op.add_column(sa.Column('district_id', sa.Uuid(), nullable=True))
        batch_op.create_index(batch_op.f('ix_crm_cities_district_id'), ['district_id'], unique=False)
        batch_op.create_foreign_key(
            batch_op.f('fk_crm_cities_district_id_crm_districts'), 'crm_districts',
            ['district_id'], ['id'], ondelete='SET NULL',
        )


def downgrade() -> None:
    with op.batch_alter_table('crm_cities', schema=None) as batch_op:
        batch_op.drop_constraint(batch_op.f('fk_crm_cities_district_id_crm_districts'), type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_crm_cities_district_id'))
        batch_op.drop_column('district_id')

    with op.batch_alter_table('crm_districts', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_crm_districts_state_id'))
        batch_op.drop_index(batch_op.f('ix_crm_districts_org_id'))

    op.drop_table('crm_districts')
