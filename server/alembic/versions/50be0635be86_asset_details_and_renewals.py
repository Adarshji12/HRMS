"""asset details and renewals

Revision ID: 50be0635be86
Revises: bd365c1a2ac6
Create Date: 2026-10-20 11:23:07.001090

The asset register grows from "tag, category, serial" into a full record:
name, brand/model, vendor, invoice, cost, location, warranty, and renewal
tracking (next due date, cycle, cost, reminder window). ``asset_renewals`` is
the append-only history of every renewal. ``assets.category`` widens to 40
characters because the category is now an open-ended slug.

Hand-trimmed: autogenerate also proposed dropping ``updated_at`` from unrelated
tables and a constraint on ``meetings`` — pre-existing drift this revision must
not touch.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '50be0635be86'
down_revision: Union[str, None] = 'bd365c1a2ac6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('asset_renewals',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('asset_id', sa.Uuid(), nullable=False),
    sa.Column('renewed_on', sa.Date(), nullable=False),
    sa.Column('previous_due', sa.Date(), nullable=True),
    sa.Column('next_due', sa.Date(), nullable=True),
    sa.Column('cost_paise', sa.BigInteger(), nullable=True),
    sa.Column('reference', sa.String(length=120), nullable=True),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('renewed_by_id', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['asset_id'], ['assets.id'], name=op.f('fk_asset_renewals_asset_id_assets'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_asset_renewals_org_id_organizations'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['renewed_by_id'], ['users.id'], name=op.f('fk_asset_renewals_renewed_by_id_users'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_asset_renewals'))
    )
    with op.batch_alter_table('asset_renewals', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_asset_renewals_asset_id'), ['asset_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_asset_renewals_org_id'), ['org_id'], unique=False)

    with op.batch_alter_table('assets', schema=None) as batch_op:
        batch_op.add_column(sa.Column('name', sa.String(length=160), nullable=True))
        batch_op.add_column(sa.Column('brand', sa.String(length=120), nullable=True))
        batch_op.add_column(sa.Column('model_name', sa.String(length=120), nullable=True))
        batch_op.add_column(sa.Column('vendor', sa.String(length=160), nullable=True))
        batch_op.add_column(sa.Column('invoice_number', sa.String(length=80), nullable=True))
        batch_op.add_column(sa.Column('purchase_cost_paise', sa.BigInteger(), nullable=True))
        batch_op.add_column(sa.Column('location', sa.String(length=160), nullable=True))
        batch_op.add_column(sa.Column('warranty_expiry', sa.Date(), nullable=True))
        batch_op.add_column(sa.Column('renewal_date', sa.Date(), nullable=True))
        batch_op.add_column(sa.Column('renewal_cycle', sa.String(length=20), server_default='none', nullable=False))
        batch_op.add_column(sa.Column('renewal_cost_paise', sa.BigInteger(), nullable=True))
        batch_op.add_column(sa.Column('reminder_days', sa.Integer(), server_default='30', nullable=False))
        batch_op.add_column(sa.Column('auto_renew', sa.Boolean(), server_default='0', nullable=False))
        batch_op.add_column(sa.Column('notes', sa.Text(), nullable=True))

    # SQLite does not enforce VARCHAR lengths, and widening there would force a
    # batch rebuild of ``assets`` -- dropping a table that asset_assignments
    # cascades from. Only Postgres needs (and safely gets) the ALTER.
    if op.get_bind().dialect.name != 'sqlite':
        op.alter_column('assets', 'category',
                        existing_type=sa.VARCHAR(length=20),
                        type_=sa.String(length=40),
                        existing_nullable=False)


def downgrade() -> None:
    if op.get_bind().dialect.name != 'sqlite':
        op.alter_column('assets', 'category',
                        existing_type=sa.String(length=40),
                        type_=sa.VARCHAR(length=20),
                        existing_nullable=False)
    with op.batch_alter_table('assets', schema=None) as batch_op:
        for column in ('notes', 'auto_renew', 'reminder_days', 'renewal_cost_paise',
                       'renewal_cycle', 'renewal_date', 'warranty_expiry', 'location',
                       'purchase_cost_paise', 'invoice_number', 'vendor', 'model_name',
                       'brand', 'name'):
            batch_op.drop_column(column)

    with op.batch_alter_table('asset_renewals', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_asset_renewals_org_id'))
        batch_op.drop_index(batch_op.f('ix_asset_renewals_asset_id'))

    op.drop_table('asset_renewals')
