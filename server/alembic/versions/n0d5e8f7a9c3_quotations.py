"""ERP quotations share the sale-bill tables

Revision ID: n0d5e8f7a9c3
Revises: m9c4d7e6f8b2
"""

import sqlalchemy as sa
from alembic import op

revision = "n0d5e8f7a9c3"
down_revision = "m9c4d7e6f8b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("erp_sale_bills") as batch:
        batch.add_column(sa.Column("doc_type", sa.String(length=12), nullable=False, server_default="bill"))
        batch.add_column(sa.Column("valid_till", sa.Date(), nullable=True))
        batch.add_column(sa.Column("status", sa.String(length=12), nullable=False, server_default="open"))
        batch.create_index(op.f("ix_erp_sale_bills_doc_type"), ["doc_type"])


def downgrade() -> None:
    with op.batch_alter_table("erp_sale_bills") as batch:
        batch.drop_index(op.f("ix_erp_sale_bills_doc_type"))
        batch.drop_column("status")
        batch.drop_column("valid_till")
        batch.drop_column("doc_type")
