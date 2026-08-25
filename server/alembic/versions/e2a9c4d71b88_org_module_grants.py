"""Per-company module grants

Revision ID: e2a9c4d71b88
Revises: d1f8b4c609ee
Create Date: 2026-08-23 12:10:00.000000

One additive column on `organizations`, holding per-company overrides of the
module list the plan allows: `{"leave": false, "assets": true}`. A key present
forces that answer; a key absent inherits the plan.

An object rather than two arrays, because "inherit" has to be representable.
With granted/revoked lists, an operator who toggles a switch on and then off
again leaves the company pinned to a value the plan no longer controls — and the
bug only shows up months later when the plan changes and one customer does not
follow.

`server_default='{}'` keeps this additive: every existing company inherits its
plan exactly as it did before this migration, so applying it changes nobody's
access.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e2a9c4d71b88'
down_revision: Union[str, None] = 'd1f8b4c609ee'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('organizations', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('module_grants', sa.JSON(), nullable=False, server_default='{}')
        )


def downgrade() -> None:
    with op.batch_alter_table('organizations', schema=None) as batch_op:
        batch_op.drop_column('module_grants')
