"""Approval rules: per-level switches and per-flow switches

Revision ID: p6b0c3e2f947
Revises: o5a9b2d1e836

Levels gain Mandatory, Auto skip and Final. Each request type gains an Enabled switch and
three flow switches: Sequential approval, A rejection ends it, Notify the approver.

Every default reproduces what the engine already did: a level is mandatory, does not skip
itself when nobody is assigned (it shows as unassigned), and is not final; a flow is
enabled, runs one level at a time, and a rejection ends the request.
"""

import sqlalchemy as sa
from alembic import op

revision = "p6b0c3e2f947"
down_revision = "o5a9b2d1e836"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("workflow_levels") as batch:
        batch.add_column(sa.Column("is_mandatory", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column("auto_skip", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("is_final", sa.Boolean(), nullable=False, server_default=sa.false()))
    with op.batch_alter_table("workflow_steps") as batch:
        batch.add_column(sa.Column("is_mandatory", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column("is_final", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_table(
        "workflow_flows",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sequential", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("reject_ends", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("notify_approver", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "kind", name="uq_workflow_flows_org_kind"),
    )
    op.create_index("ix_workflow_flows_org_id", "workflow_flows", ["org_id"])


def downgrade() -> None:
    op.drop_index("ix_workflow_flows_org_id", table_name="workflow_flows")
    op.drop_table("workflow_flows")
    with op.batch_alter_table("workflow_steps") as batch:
        batch.drop_column("is_final")
        batch.drop_column("is_mandatory")
    with op.batch_alter_table("workflow_levels") as batch:
        batch.drop_column("is_final")
        batch.drop_column("auto_skip")
        batch.drop_column("is_mandatory")
