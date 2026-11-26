"""Helpdesk incident details

Revision ID: p2f7b0a9c1e5
Revises: o1e6f9a8b0d4
"""

import sqlalchemy as sa
from alembic import op

revision = "p2f7b0a9c1e5"
down_revision = "o1e6f9a8b0d4"
branch_labels = None
depends_on = None

COLUMNS = [
    ("incident_on", sa.DateTime(timezone=True)),
    ("customer_name", sa.String(length=200)),
    ("contact_name", sa.String(length=160)),
    ("contact_email", sa.String(length=200)),
    ("contact_phone", sa.String(length=40)),
    ("address", sa.Text()),
    ("city", sa.String(length=120)),
    ("state", sa.String(length=120)),
    ("pincode", sa.String(length=20)),
]


def upgrade() -> None:
    with op.batch_alter_table("helpdesk_tickets") as batch:
        for name, kind in COLUMNS:
            batch.add_column(sa.Column(name, kind, nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("helpdesk_tickets") as batch:
        for name, _ in COLUMNS:
            batch.drop_column(name)
