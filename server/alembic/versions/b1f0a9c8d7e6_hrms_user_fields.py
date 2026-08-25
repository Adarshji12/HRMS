"""HRMS: user lifecycle status and module permission flags

Revision ID: b1f0a9c8d7e6
Revises: a3f1c72b9d04
Create Date: 2026-08-22 21:30:00.000000

First of the Phase 0 HRMS migrations. Additive only: six new columns on `users`,
nothing existing renamed or repurposed.

Hand-written rather than taken from autogenerate, because autogenerate renders
these as plain `add_column(..., nullable=False)` with no server default. The
model's Python-side `default=` is applied by the ORM on insert and does nothing
during ALTER TABLE, so that version fails on any database that already has a
single user in it — which is every real one. `server_default` is what makes an
additive column additive. This follows eb76bedd2dae, which added the first four
permission flags the same way.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b1f0a9c8d7e6'
down_revision: Union[str, None] = 'a3f1c72b9d04'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        # "active", not "pending_setup": every account that exists when this
        # runs belongs to someone already working here. Defaulting to
        # pending_setup would silently reclassify an entire company as
        # pre-joiners, and the onboarding pipeline would then offer to onboard
        # all of them.
        batch_op.add_column(sa.Column('status', sa.String(length=24), nullable=False,
                                      server_default=sa.text("'active'")))
        # True, matching the four flags eb76bedd2dae added: these RESTRICT
        # rather than grant, so defaulting them on means existing accounts keep
        # exactly the behaviour they had and no backfill is needed.
        batch_op.add_column(sa.Column('can_approve_leave', sa.Boolean(), nullable=False,
                                      server_default=sa.true()))
        batch_op.add_column(sa.Column('can_approve_regularization', sa.Boolean(), nullable=False,
                                      server_default=sa.true()))
        batch_op.add_column(sa.Column('can_manage_assets', sa.Boolean(), nullable=False,
                                      server_default=sa.true()))
        batch_op.add_column(sa.Column('can_manage_onboarding', sa.Boolean(), nullable=False,
                                      server_default=sa.true()))
        batch_op.add_column(sa.Column('can_manage_helpdesk', sa.Boolean(), nullable=False,
                                      server_default=sa.true()))
        batch_op.create_index(batch_op.f('ix_users_status'), ['status'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_users_status'))
        batch_op.drop_column('can_manage_helpdesk')
        batch_op.drop_column('can_manage_onboarding')
        batch_op.drop_column('can_manage_assets')
        batch_op.drop_column('can_approve_regularization')
        batch_op.drop_column('can_approve_leave')
        batch_op.drop_column('status')
