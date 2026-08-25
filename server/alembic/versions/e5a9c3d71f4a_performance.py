"""Performance: appraisal cycles, goals, competencies and reviews

Revision ID: e5a9c3d71f4a
Revises: d4f8b2c60e39
Create Date: 2026-08-25 14:00:00.000000

Five new tables, no changes to existing ones. Points worth knowing before
reading the DDL:

* ``review_cycles.rating_max`` and ``rating_labels`` are the scale, and
  ``performance_reviews`` has **its own copies**, written at finalisation. That
  is not denormalisation by accident: a company moving from a 1-5 scale to 1-4
  must not rescale last year's ratings, and a "4" without the scale it was given
  on is a digit rather than a rating.

* ``performance_goals.weight_bps`` is basis points, like every rate in this
  schema. The set must total 10,000, enforced in the service at submission the
  way a salary structure enforces its components summing to gross.

* ``performance_reviews.score_centi`` is the weighted mean in **hundredths**.
  Integer, because a float rating is a figure that renders differently in two
  places and ends a performance conversation badly.

* ``competency_ratings.competency_name`` is copied from the catalogue, the same
  discipline payslip lines use. Renaming "Ownership" to "Accountability" must
  not rewrite what somebody was rated on three years ago.

* The competency reference is **RESTRICT** — a competency a review used is
  deactivated, never deleted. Everything else cascades from the org or the
  cycle, because a deleted cycle's goals are not evidence of anything.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e5a9c3d71f4a'
down_revision: Union[str, None] = 'd4f8b2c60e39'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "review_cycles",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("self_review_closes", sa.Date(), nullable=True),
        sa.Column("manager_review_closes", sa.Date(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False,
                  server_default=sa.text("'draft'")),
        sa.Column("rating_max", sa.Integer(), nullable=False, server_default=sa.text("5")),
        sa.Column("rating_labels", sa.JSON(), nullable=True),
        sa.Column("requires_self_review", sa.Boolean(), nullable=False,
                  server_default=sa.true()),
        sa.Column("weights_must_total", sa.Boolean(), nullable=False,
                  server_default=sa.true()),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "name", name="uq_review_cycles_org_name"),
    )
    op.create_index("ix_review_cycles_org_id", "review_cycles", ["org_id"])
    op.create_index("ix_review_cycles_org_status", "review_cycles", ["org_id", "status"])

    op.create_table(
        "competencies",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "name", name="uq_competencies_org_name"),
    )
    op.create_index("ix_competencies_org_id", "competencies", ["org_id"])

    op.create_table(
        "performance_goals",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("cycle_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("weight_bps", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("target", sa.Text(), nullable=True),
        sa.Column("self_rating", sa.Integer(), nullable=True),
        sa.Column("manager_rating", sa.Integer(), nullable=True),
        sa.Column("self_comment", sa.Text(), nullable=True),
        sa.Column("manager_comment", sa.Text(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["cycle_id"], ["review_cycles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_performance_goals_org_id", "performance_goals", ["org_id"])
    op.create_index("ix_performance_goals_cycle_id", "performance_goals", ["cycle_id"])
    op.create_index("ix_performance_goals_user_id", "performance_goals", ["user_id"])
    op.create_index("ix_performance_goals_cycle_user", "performance_goals",
                    ["cycle_id", "user_id", "sort_order"])

    op.create_table(
        "performance_reviews",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("cycle_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("manager_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False,
                  server_default=sa.text("'draft'")),
        sa.Column("self_comment", sa.Text(), nullable=True),
        sa.Column("self_submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reviewed_by", sa.Uuid(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_note", sa.Text(), nullable=True),
        sa.Column("overall_rating", sa.Integer(), nullable=True),
        sa.Column("override_reason", sa.Text(), nullable=True),
        sa.Column("final_comment", sa.Text(), nullable=True),
        sa.Column("score_centi", sa.Integer(), nullable=True),
        sa.Column("rating_max", sa.Integer(), nullable=True),
        sa.Column("finalised_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finalised_by", sa.Uuid(), nullable=True),
        sa.Column("shared_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["cycle_id"], ["review_cycles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        # SET NULL on the three reviewer columns: the manager who wrote somebody's
        # appraisal will one day leave, and losing them must not erase the review.
        sa.ForeignKeyConstraint(["manager_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["reviewed_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["finalised_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("cycle_id", "user_id", name="uq_performance_reviews_cycle_user"),
    )
    op.create_index("ix_performance_reviews_org_id", "performance_reviews", ["org_id"])
    op.create_index("ix_performance_reviews_cycle_id", "performance_reviews", ["cycle_id"])
    op.create_index("ix_performance_reviews_user_id", "performance_reviews", ["user_id"])
    op.create_index("ix_performance_reviews_org_status", "performance_reviews",
                    ["org_id", "status"])

    op.create_table(
        "competency_ratings",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("review_id", sa.Uuid(), nullable=False),
        sa.Column("competency_id", sa.Uuid(), nullable=False),
        sa.Column("competency_name", sa.String(length=120), nullable=False),
        sa.Column("self_rating", sa.Integer(), nullable=True),
        sa.Column("manager_rating", sa.Integer(), nullable=True),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["review_id"], ["performance_reviews.id"], ondelete="CASCADE"),
        # RESTRICT: a competency a review rated is deactivated, never deleted.
        sa.ForeignKeyConstraint(["competency_id"], ["competencies.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("review_id", "competency_id",
                            name="uq_competency_ratings_review_competency"),
    )
    op.create_index("ix_competency_ratings_org_id", "competency_ratings", ["org_id"])
    op.create_index("ix_competency_ratings_review_id", "competency_ratings", ["review_id"])


    # The capability flag. Default **True**, like every flag but payroll: an
    # appraisal discloses a manager's opinion, which is sensitive but not in the
    # way a salary is, and the house rule is that a flag narrows rather than
    # grants. Defaulting it False would silently lock every existing
    # administrator out of a module they were just granted.
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("can_manage_performance", sa.Boolean(),
                                   nullable=False, server_default=sa.true()))


def downgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.drop_column("can_manage_performance")
    op.drop_table("competency_ratings")
    op.drop_table("performance_reviews")
    op.drop_table("performance_goals")
    op.drop_table("competencies")
    op.drop_table("review_cycles")
