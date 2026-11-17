"""opportunity pipeline stage

Revision ID: a5d1e8c3b926
Revises: f2a9c4e7b318
"""

import sqlalchemy as sa
from alembic import op

revision = "a5d1e8c3b926"
down_revision = "f2a9c4e7b318"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("crm_opportunities") as batch:
        batch.add_column(
            sa.Column("stage", sa.String(12), nullable=False, server_default="qualified")
        )
        batch.create_index("ix_crm_opportunities_stage", ["stage"])


def downgrade() -> None:
    with op.batch_alter_table("crm_opportunities") as batch:
        batch.drop_index("ix_crm_opportunities_stage")
        batch.drop_column("stage")
