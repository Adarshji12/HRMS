"""A return that is replaced from the same order.

Revision ID: d3b8f1c6a457
Revises: e4b7c2f8a615
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d3b8f1c6a457"
down_revision: Union[str, None] = "e4b7c2f8a615"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("erp_dispatch_lines", schema=None) as batch_op:
        batch_op.add_column(sa.Column("replaced_qty", sa.Numeric(14, 3), nullable=False, server_default="0"))
        batch_op.add_column(sa.Column("free_qty", sa.Numeric(14, 3), nullable=False, server_default="0"))
    with op.batch_alter_table("erp_sales_order_lines", schema=None) as batch_op:
        batch_op.add_column(sa.Column("free_replacement_qty", sa.Numeric(14, 3), nullable=False, server_default="0"))
    with op.batch_alter_table("erp_sales_returns", schema=None) as batch_op:
        batch_op.add_column(sa.Column("replace", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("erp_sales_returns", schema=None) as batch_op:
        batch_op.drop_column("replace")
    with op.batch_alter_table("erp_sales_order_lines", schema=None) as batch_op:
        batch_op.drop_column("free_replacement_qty")
    with op.batch_alter_table("erp_dispatch_lines", schema=None) as batch_op:
        batch_op.drop_column("free_qty")
        batch_op.drop_column("replaced_qty")
