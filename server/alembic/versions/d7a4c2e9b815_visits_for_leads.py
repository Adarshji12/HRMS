"""visits for leads

Revision ID: d7a4c2e9b815
Revises: c5f2a9e7d413
Create Date: 2026-10-28 10:00:00.000000

A visit can now be booked against a lead as well as a customer: a sales demo
happens before anyone is a customer. ``customer_id`` becomes optional, a
``lead_id`` joins it, and a check keeps exactly one of the two set. Every
existing visit has a customer and no lead, so all of them already satisfy it.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd7a4c2e9b815'
down_revision: Union[str, None] = 'c5f2a9e7d413'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('crm_visits', schema=None) as batch_op:
        batch_op.add_column(sa.Column('lead_id', sa.Uuid(), nullable=True))
        batch_op.create_foreign_key(
            batch_op.f('fk_crm_visits_lead_id_crm_leads'),
            'crm_leads', ['lead_id'], ['id'], ondelete='CASCADE',
        )
        batch_op.create_index('ix_crm_visits_lead', ['lead_id'], unique=False)
        batch_op.alter_column('customer_id', existing_type=sa.Uuid(), nullable=True)
        batch_op.create_check_constraint(
            'ck_crm_visits_one_subject', '(lead_id IS NULL) <> (customer_id IS NULL)'
        )


def downgrade() -> None:
    # Lead visits have nowhere to go once the column is gone.
    op.execute("DELETE FROM crm_visits WHERE customer_id IS NULL")
    with op.batch_alter_table('crm_visits', schema=None) as batch_op:
        batch_op.drop_constraint('ck_crm_visits_one_subject', type_='check')
        batch_op.alter_column('customer_id', existing_type=sa.Uuid(), nullable=False)
        batch_op.drop_index('ix_crm_visits_lead')
        batch_op.drop_constraint(batch_op.f('fk_crm_visits_lead_id_crm_leads'), type_='foreignkey')
        batch_op.drop_column('lead_id')
