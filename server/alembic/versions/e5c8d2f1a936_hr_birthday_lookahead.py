"""HR settings: how far ahead birthdays are listed

Revision ID: e5c8d2f1a936
Revises: d4a7b1c9e268

One column, defaulting to 30 days, so every workspace keeps working unchanged.
"""

import sqlalchemy as sa
from alembic import op

revision = "e5c8d2f1a936"
down_revision = "d4a7b1c9e268"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("hr_settings") as batch:
        batch.add_column(sa.Column("birthday_lookahead_days", sa.Integer(), nullable=False, server_default="30"))


def downgrade() -> None:
    with op.batch_alter_table("hr_settings") as batch:
        batch.drop_column("birthday_lookahead_days")
