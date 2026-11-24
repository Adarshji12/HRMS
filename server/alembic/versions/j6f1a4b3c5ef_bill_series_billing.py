"""Bill series: billing type, print layout, paper, users

Revision ID: j6f1a4b3c5ef
Revises: i5e0f3a2b4de
"""

import sqlalchemy as sa
from alembic import op

revision = "j6f1a4b3c5ef"
down_revision = "i5e0f3a2b4de"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("erp_bill_series") as b:
        b.add_column(sa.Column("billing_type", sa.String(length=10), nullable=False, server_default="company"))
        b.add_column(sa.Column("print_layout", sa.String(length=40), nullable=True))
        b.add_column(sa.Column("paper", sa.String(length=16), nullable=False, server_default="saved"))
        b.add_column(sa.Column("user_ids", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("erp_bill_series") as b:
        for col in ("user_ids", "paper", "print_layout", "billing_type"):
            b.drop_column(col)
