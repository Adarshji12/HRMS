"""Helpdesk ticket numbers

Revision ID: q3a8c1b0d2f6
Revises: p2f7b0a9c1e5
"""

import sqlalchemy as sa
from alembic import op

revision = "q3a8c1b0d2f6"
down_revision = "p2f7b0a9c1e5"
branch_labels = None
depends_on = None

FIRST = 1001


def upgrade() -> None:
    with op.batch_alter_table("helpdesk_tickets") as batch:
        batch.add_column(sa.Column("ticket_no", sa.Integer(), nullable=True))
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, org_id FROM helpdesk_tickets ORDER BY org_id, created_at, id")).fetchall()
    counters: dict = {}
    for row in rows:
        n = counters.get(row.org_id, FIRST)
        counters[row.org_id] = n + 1
        bind.execute(sa.text("UPDATE helpdesk_tickets SET ticket_no = :n WHERE id = :i"), {"n": n, "i": row.id})
    op.create_index("ix_helpdesk_tickets_org_no", "helpdesk_tickets", ["org_id", "ticket_no"])


def downgrade() -> None:
    op.drop_index("ix_helpdesk_tickets_org_no", table_name="helpdesk_tickets")
    with op.batch_alter_table("helpdesk_tickets") as batch:
        batch.drop_column("ticket_no")
