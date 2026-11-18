"""why an opportunity was lost

Revision ID: b8e3f5a1c704
Revises: a5d1e8c3b926
"""

import sqlalchemy as sa
from alembic import op

revision = "b8e3f5a1c704"
down_revision = "a5d1e8c3b926"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("crm_opportunities") as batch:
        batch.add_column(sa.Column("lost_reason", sa.String(300), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("crm_opportunities") as batch:
        batch.drop_column("lost_reason")
