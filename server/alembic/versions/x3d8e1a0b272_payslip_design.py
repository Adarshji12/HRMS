"""Payslip design

Revision ID: x3d8e1a0b272
Revises: w2c7d0f9a161
"""

import sqlalchemy as sa
from alembic import op

revision = "x3d8e1a0b272"
down_revision = "w2c7d0f9a161"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "payslip_designs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("org_id", sa.Uuid(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("data", sa.JSON(), nullable=False),
    )
    op.create_index("ix_payslip_designs_org_id", "payslip_designs", ["org_id"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_payslip_designs_org_id", table_name="payslip_designs")
    op.drop_table("payslip_designs")
