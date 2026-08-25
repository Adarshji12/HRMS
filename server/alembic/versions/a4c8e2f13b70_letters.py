"""Letters: templates and issued letters

Revision ID: a4c8e2f13b70
Revises: f3b7d1a90c45
Create Date: 2026-08-24 05:10:00.000000

Two new tables and one additive column on `users`.

`issued_letters.body` holds the rendered text, not a reference to the template
that produced it. A letter states facts as they stood on the day it was signed;
re-rendering later would silently rewrite a document somebody's bank already
holds. The `template_id` FK is therefore SET NULL rather than CASCADE — deleting
a template must leave every letter issued from it intact.

`reference_no` is unique per organisation, not globally: two companies both
numbering from ACME/HR/2026/0001 is expected. It is nullable because a draft has
no number — allocation at issue is what makes a number mean "this was actually
issued" rather than "somebody opened a preview".

`users.can_issue_letters` defaults to true, matching every other flag in that
set: they restrict rather than grant, so a default of false would take the new
capability away from the HR staff who should have it.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a4c8e2f13b70'
down_revision: Union[str, None] = 'f3b7d1a90c45'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'letter_templates',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('name', sa.String(length=160), nullable=False),
        sa.Column('letter_type', sa.String(length=32), nullable=False,
                  server_default='custom'),
        sa.Column('description', sa.String(length=400), nullable=True),
        sa.Column('subject', sa.String(length=300), nullable=True),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('signatory_name', sa.String(length=160), nullable=True),
        sa.Column('signatory_title', sa.String(length=160), nullable=True),
        sa.Column('employee_requestable', sa.Boolean(), nullable=False,
                  server_default=sa.false()),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_by', sa.Uuid(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_letter_templates_org_id', 'letter_templates', ['org_id'])
    op.create_index('ix_letter_templates_org_type', 'letter_templates',
                    ['org_id', 'letter_type'])

    op.create_table(
        'issued_letters',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('template_id', sa.Uuid(), nullable=True),
        sa.Column('letter_type', sa.String(length=32), nullable=False),
        sa.Column('template_name', sa.String(length=160), nullable=True),
        sa.Column('reference_no', sa.String(length=60), nullable=True),
        sa.Column('subject', sa.String(length=300), nullable=True),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('signatory_name', sa.String(length=160), nullable=True),
        sa.Column('signatory_title', sa.String(length=160), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False, server_default='draft'),
        sa.Column('issued_on', sa.Date(), nullable=True),
        sa.Column('issued_by', sa.Uuid(), nullable=True),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('revoked_by', sa.Uuid(), nullable=True),
        sa.Column('revoked_reason', sa.Text(), nullable=True),
        sa.Column('document_id', sa.Uuid(), nullable=True),
        sa.Column('requested_by', sa.Uuid(), nullable=True),
        sa.Column('request_note', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['template_id'], ['letter_templates.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['issued_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['revoked_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['requested_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['document_id'], ['employee_documents.id'],
                                ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('org_id', 'reference_no', name='uq_issued_letters_reference'),
    )
    op.create_index('ix_issued_letters_org_id', 'issued_letters', ['org_id'])
    op.create_index('ix_issued_letters_user_id', 'issued_letters', ['user_id'])
    op.create_index('ix_issued_letters_user', 'issued_letters',
                    ['org_id', 'user_id', 'letter_type'])
    op.create_index('ix_issued_letters_status', 'issued_letters', ['org_id', 'status'])

    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('can_issue_letters', sa.Boolean(), nullable=False,
                      server_default=sa.true())
        )


def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('can_issue_letters')

    op.drop_index('ix_issued_letters_status', table_name='issued_letters')
    op.drop_index('ix_issued_letters_user', table_name='issued_letters')
    op.drop_index('ix_issued_letters_user_id', table_name='issued_letters')
    op.drop_index('ix_issued_letters_org_id', table_name='issued_letters')
    op.drop_table('issued_letters')

    op.drop_index('ix_letter_templates_org_type', table_name='letter_templates')
    op.drop_index('ix_letter_templates_org_id', table_name='letter_templates')
    op.drop_table('letter_templates')
