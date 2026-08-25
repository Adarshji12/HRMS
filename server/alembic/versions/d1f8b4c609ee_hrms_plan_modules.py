"""HRMS: per-plan module entitlement

Revision ID: d1f8b4c609ee
Revises: c0e7a3b68d77
Create Date: 2026-08-23 00:20:00.000000

One additive column on `plans`, holding the HRMS module keys a plan includes
(§9.5). Machine-readable, and deliberately separate from `features`, which is
marketing copy for the pricing page — gating on a display string would mean
rewording an advert silently revokes a customer's access.

`server_default='[]'` is what makes this additive: an empty list means **every
module**, so every plan that exists when this runs stays unrestricted, and so
does every plan an operator later creates without touching the field. A gate
whose default is deny would turn one forgotten checkbox into a paying customer
losing a module.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd1f8b4c609ee'
down_revision: Union[str, None] = 'c0e7a3b68d77'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('plans', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('modules', sa.JSON(), nullable=False, server_default='[]')
        )


def downgrade() -> None:
    with op.batch_alter_table('plans', schema=None) as batch_op:
        batch_op.drop_column('modules')
