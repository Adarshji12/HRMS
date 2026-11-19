"""Designations: an optional short code

Revision ID: f6d9e3a2b047
Revises: e5c8d2f1a936

A few letters for a title ("SE" for Senior Executive), shown on the designation
form. Optional and not unique: nothing looks a designation up by it.
"""

import sqlalchemy as sa
from alembic import op

revision = "f6d9e3a2b047"
down_revision = "e5c8d2f1a936"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("designations") as batch:
        batch.add_column(sa.Column("code", sa.String(length=12), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("designations") as batch:
        batch.drop_column("code")
