"""role menu rights

Revision ID: c5f2a9e7d413
Revises: b3e8d1f4c702
Create Date: 2026-10-21 18:00:00.000000

Per-menu Access / Add / Edit / Delete on a named role. Added empty (NULL) for
every existing role, which means "never restricted by menu" — every company
keeps exactly the access it has until somebody edits a role on the new screen.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c5f2a9e7d413'
down_revision: Union[str, None] = 'b3e8d1f4c702'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('org_roles', schema=None) as batch_op:
        batch_op.add_column(sa.Column('menu_rights', sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('org_roles', schema=None) as batch_op:
        batch_op.drop_column('menu_rights')
