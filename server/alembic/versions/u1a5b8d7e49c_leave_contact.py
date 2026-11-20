"""Contact while away on a leave application

Revision ID: u1a5b8d7e49c
Revises: t0f4a7c6d38b
"""

import sqlalchemy as sa
from alembic import op

revision = "u1a5b8d7e49c"
down_revision = "t0f4a7c6d38b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("leave_applications") as batch:
        batch.add_column(sa.Column("contact_phone", sa.String(40), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("leave_applications") as batch:
        batch.drop_column("contact_phone")
