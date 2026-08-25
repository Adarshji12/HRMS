"""Engagement: announcements, pulse surveys and recognition

Revision ID: f6b1d4e82a5c
Revises: e5a9c3d71f4a
Create Date: 2026-08-25 17:00:00.000000

Eight tables. Seven are ordinary; the eighth is the point of the module.

**`survey_responses.user_id` is nullable, and for an anonymous survey it is
never written.** Anonymity here is structural rather than a promise: there is no
column on a response that can be joined back to a person, so the join is not
merely discouraged, it is impossible. Preventing a second submission still works
— through `survey_participants`, which records *that* somebody answered and
never *what* they answered. The two tables share no key.

That is why they are two tables. A single `survey_responses` row carrying both
"who" and "what" with the "who" blanked would be one careless migration away
from being repopulated, and one well-meaning "who hasn't responded yet" report
away from being joined.

The column stays nullable rather than being dropped because an **attributed**
survey is a real instrument — a manager-effectiveness round that names the
respondent is legitimate, and refusing to model it would push companies into
running it over email instead, where it is neither anonymous nor recorded.

Two smaller notes:

* `recognitions.competency_id` is **RESTRICT**, like every other reference to
  the competency catalogue. One a recognition cites is deactivated, never
  deleted.
* `recognitions.from_user_id` and `to_user_id` are **SET NULL**: somebody
  leaving must not erase the thanks they gave or received.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f6b1d4e82a5c'
down_revision: Union[str, None] = 'e5a9c3d71f4a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "announcements",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False,
                  server_default=sa.text("'draft'")),
        sa.Column("audience_kind", sa.String(length=16), nullable=False,
                  server_default=sa.text("'everyone'")),
        sa.Column("audience_ids", sa.JSON(), nullable=True),
        sa.Column("is_pinned", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("requires_acknowledgement", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
        sa.Column("expires_on", sa.Date(), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("published_by", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["published_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_announcements_org_id", "announcements", ["org_id"])
    op.create_index("ix_announcements_org_status", "announcements", ["org_id", "status"])

    op.create_table(
        "announcement_reads",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("announcement_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        # Two timestamps, not one flag. Opening a post is passive; acknowledging
        # is an act, and "97% have read it" is not an answer to "has everybody
        # accepted the new policy".
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["announcement_id"], ["announcements.id"],
                                ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("announcement_id", "user_id",
                            name="uq_announcement_reads_post_user"),
    )
    op.create_index("ix_announcement_reads_org_id", "announcement_reads", ["org_id"])
    op.create_index("ix_announcement_reads_announcement_id", "announcement_reads",
                    ["announcement_id"])
    op.create_index("ix_announcement_reads_user_id", "announcement_reads", ["user_id"])

    op.create_table(
        "surveys",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False,
                  server_default=sa.text("'draft'")),
        sa.Column("audience_kind", sa.String(length=16), nullable=False,
                  server_default=sa.text("'everyone'")),
        sa.Column("audience_ids", sa.JSON(), nullable=True),
        # Immutable once the survey opens — the service refuses. Flipping it
        # afterwards retroactively exposes people who answered believing
        # otherwise.
        sa.Column("is_anonymous", sa.Boolean(), nullable=False, server_default=sa.true()),
        # The floor for showing results and for any breakdown of them. Four, not
        # three: everyone in a four-person team can work out who said what from
        # a three-response average.
        sa.Column("min_responses", sa.Integer(), nullable=False, server_default=sa.text("4")),
        sa.Column("opens_on", sa.Date(), nullable=True),
        sa.Column("closes_on", sa.Date(), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_surveys_org_id", "surveys", ["org_id"])
    op.create_index("ix_surveys_org_status", "surveys", ["org_id", "status"])

    op.create_table(
        "survey_questions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("survey_id", sa.Uuid(), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("kind", sa.String(length=12), nullable=False,
                  server_default=sa.text("'scale'")),
        sa.Column("scale_max", sa.Integer(), nullable=False, server_default=sa.text("5")),
        sa.Column("choices", sa.JSON(), nullable=True),
        sa.Column("is_required", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["survey_id"], ["surveys.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_survey_questions_org_id", "survey_questions", ["org_id"])
    op.create_index("ix_survey_questions_survey_id", "survey_questions", ["survey_id"])

    # Who was asked, and whether they answered. Never what they answered.
    op.create_table(
        "survey_participants",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("survey_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["survey_id"], ["surveys.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("survey_id", "user_id", name="uq_survey_participants"),
    )
    op.create_index("ix_survey_participants_org_id", "survey_participants", ["org_id"])
    op.create_index("ix_survey_participants_survey_id", "survey_participants",
                    ["survey_id"])
    op.create_index("ix_survey_participants_user_id", "survey_participants", ["user_id"])

    # What was answered. For an anonymous survey `user_id` is NULL and is never
    # written — see the revision docstring.
    op.create_table(
        "survey_responses",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("survey_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["survey_id"], ["surveys.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_survey_responses_org_id", "survey_responses", ["org_id"])
    op.create_index("ix_survey_responses_survey_id", "survey_responses", ["survey_id"])

    op.create_table(
        "survey_answers",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("response_id", sa.Uuid(), nullable=False),
        sa.Column("question_id", sa.Uuid(), nullable=False),
        # Three typed columns rather than one blob: a rating that gets averaged
        # has to be an integer the database understands.
        sa.Column("rating", sa.Integer(), nullable=True),
        sa.Column("text", sa.Text(), nullable=True),
        sa.Column("choice", sa.String(length=200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["response_id"], ["survey_responses.id"],
                                ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["question_id"], ["survey_questions.id"],
                                ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_survey_answers_org_id", "survey_answers", ["org_id"])
    op.create_index("ix_survey_answers_response_id", "survey_answers", ["response_id"])
    op.create_index("ix_survey_answers_question", "survey_answers", ["question_id"])

    op.create_table(
        "recognitions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("from_user_id", sa.Uuid(), nullable=True),
        sa.Column("to_user_id", sa.Uuid(), nullable=True),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("competency_id", sa.Uuid(), nullable=True),
        sa.Column("is_public", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["from_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["to_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["competency_id"], ["competencies.id"],
                                ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_recognitions_org_id", "recognitions", ["org_id"])
    op.create_index("ix_recognitions_from_user_id", "recognitions", ["from_user_id"])
    op.create_index("ix_recognitions_to_user_id", "recognitions", ["to_user_id"])
    op.create_index("ix_recognitions_org_created", "recognitions",
                    ["org_id", "created_at"])

    # The capability flag. Default True, like every flag but payroll — see the
    # house rule: a flag narrows, it never grants.
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("can_manage_engagement", sa.Boolean(),
                                   nullable=False, server_default=sa.true()))


def downgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.drop_column("can_manage_engagement")
    op.drop_table("recognitions")
    op.drop_table("survey_answers")
    op.drop_table("survey_responses")
    op.drop_table("survey_participants")
    op.drop_table("survey_questions")
    op.drop_table("surveys")
    op.drop_table("announcement_reads")
    op.drop_table("announcements")
