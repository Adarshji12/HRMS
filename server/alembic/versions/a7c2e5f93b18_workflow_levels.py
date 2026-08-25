"""Multi-level approval chains: configuration and per-record steps

Revision ID: a7c2e5f93b18
Revises: f6b1d4e82a5c
Create Date: 2026-08-25 18:00:00.000000

Two tables, and the split between them is the whole design.

`workflow_levels` is configuration an administrator edits. `workflow_steps` is
the chain as it actually happened on one record, with the reviewer resolved to a
real person at the moment the request entered the flow. Nothing on a live chain
is read back through the configuration — the same discipline onboarding uses for
its checklists, and for the same reason: editing the config must not rewrite a
request already half-way through it.

**No data migration, and no behaviour change on upgrade.** A flow with no
`workflow_levels` rows decides in exactly one step under exactly the permission
rules it used before, and writes no step rows at all. Chains are opt-in per flow
and per department. That is not a migration convenience — a two-person company
routing leave through three levels is a company where nothing gets approved.

Two column choices worth stating:

* `workflow_steps.record_id` is a bare Uuid with **no foreign key**. Steps
  attach to leave applications, expense claims, loans and four other tables;
  `kind` says which, exactly as `audit_logs.target_type` already does here. A
  polymorphic FK is not a thing, and inventing seven nullable ones would be
  seven columns that are null six times out of seven.

* Every `users` reference is **SET NULL**. A reviewer who leaves must not delete
  the chain that records what they approved, and a named reviewer who leaves
  must leave a visibly broken level rather than a silently shorter chain.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7c2e5f93b18'
down_revision: Union[str, None] = 'f6b1d4e82a5c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "workflow_levels",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        # Null is the company-wide chain. A department row overrides it whole.
        sa.Column("department_id", sa.Uuid(), nullable=True),
        sa.Column("level", sa.Integer(), nullable=False),
        sa.Column("reviewer_rule", sa.String(length=24), nullable=False,
                  server_default=sa.text("'reporting_manager'")),
        sa.Column("reviewer_user_id", sa.Uuid(), nullable=True),
        # 0 = never, and it is the default: a chain that moves on by itself is a
        # chain where nobody noticed the request.
        sa.Column("auto_forward_days", sa.Integer(), nullable=False,
                  server_default=sa.text("0")),
        sa.Column("escalate_after_days", sa.Integer(), nullable=False,
                  server_default=sa.text("0")),
        sa.Column("escalate_to_user_id", sa.Uuid(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["department_id"], ["departments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reviewer_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["escalate_to_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "kind", "department_id", "level",
                            name="uq_workflow_levels_scope_level"),
    )
    op.create_index("ix_workflow_levels_org_id", "workflow_levels", ["org_id"])
    op.create_index("ix_workflow_levels_org_kind", "workflow_levels", ["org_id", "kind"])

    op.create_table(
        "workflow_steps",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("record_id", sa.Uuid(), nullable=False),
        sa.Column("subject_user_id", sa.Uuid(), nullable=True),
        sa.Column("level", sa.Integer(), nullable=False),
        sa.Column("reviewer_rule", sa.String(length=24), nullable=False),
        # Null means the rule found nobody. The step is still created, and shows
        # as unassigned — a level with no reviewer is a configuration problem
        # somebody must see, not a gate to silently skip.
        sa.Column("reviewer_user_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.String(length=12), nullable=False,
                  server_default=sa.text("'pending'")),
        sa.Column("acted_by", sa.Uuid(), nullable=True),
        sa.Column("acted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        # The escalation clock runs from here, not from when the request was
        # filed: a level waiting behind a slow predecessor has not been slow.
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("auto_forward_days", sa.Integer(), nullable=False,
                  server_default=sa.text("0")),
        sa.Column("escalate_after_days", sa.Integer(), nullable=False,
                  server_default=sa.text("0")),
        sa.Column("escalate_to_user_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["subject_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["reviewer_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["acted_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["escalate_to_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        # org_id leads: `record_id` has no FK to tie it structurally to a
        # tenant, and the isolation test requires every unique constraint to be
        # provably scoped rather than scoped by an argument about UUIDs.
        sa.UniqueConstraint("org_id", "record_id", "level",
                            name="uq_workflow_steps_record_level"),
    )
    op.create_index("ix_workflow_steps_org_id", "workflow_steps", ["org_id"])
    op.create_index("ix_workflow_steps_record_id", "workflow_steps", ["record_id"])
    op.create_index("ix_workflow_steps_reviewer_user_id", "workflow_steps",
                    ["reviewer_user_id"])
    op.create_index("ix_workflow_steps_record", "workflow_steps", ["record_id", "level"])
    op.create_index("ix_workflow_steps_pending", "workflow_steps", ["org_id", "status"])


def downgrade() -> None:
    op.drop_table("workflow_steps")
    op.drop_table("workflow_levels")
