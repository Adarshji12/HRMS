"""Core HR: employee master profile and lifetime document file

Revision ID: f3b7d1a90c45
Revises: e2a9c4d71b88
Create Date: 2026-08-23 13:05:00.000000

Two new tables and one additive column on `users`.

`employee_profiles` is keyed on `user_id`, not on an id of its own: it is
one-to-one with a user and always reached through one, so a separate primary key
would only make two profiles for one person representable.

`employee_documents` is deliberately not `onboarding_documents`. The latter
belongs to a checklist and is archived with it; this one belongs to the person
and outlives every checklist they will have. Merging them loses a hire's ID
proof the day HR tidies up their joining tasks.

Nothing is backfilled. A profile is created on first write, so applying this
gives every existing employee an empty master record rather than a wrong one —
`confirmation_status` in particular defaults to `not_applicable`, because
defaulting the whole workforce to `probation` would put every one of them onto a
confirmation report the morning after deploy.

`users.can_manage_people` defaults to true, matching every other flag in that
set: they restrict rather than grant, so a default of false would silently take
the new capability away from the HR staff who should have it.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f3b7d1a90c45'
down_revision: Union[str, None] = 'e2a9c4d71b88'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'employee_profiles',
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),

        sa.Column('date_of_birth', sa.Date(), nullable=True),
        sa.Column('gender', sa.String(length=16), nullable=True),
        sa.Column('marital_status', sa.String(length=16), nullable=True),
        sa.Column('blood_group', sa.String(length=8), nullable=True),
        sa.Column('nationality', sa.String(length=60), nullable=True),
        sa.Column('personal_email', sa.String(length=255), nullable=True),
        sa.Column('alternate_phone', sa.String(length=32), nullable=True),

        sa.Column('current_address', sa.Text(), nullable=True),
        sa.Column('current_city', sa.String(length=120), nullable=True),
        sa.Column('current_state', sa.String(length=120), nullable=True),
        sa.Column('current_postal_code', sa.String(length=20), nullable=True),
        sa.Column('current_country', sa.String(length=2), nullable=True),

        sa.Column('permanent_address', sa.Text(), nullable=True),
        sa.Column('permanent_city', sa.String(length=120), nullable=True),
        sa.Column('permanent_state', sa.String(length=120), nullable=True),
        sa.Column('permanent_postal_code', sa.String(length=20), nullable=True),
        sa.Column('permanent_country', sa.String(length=2), nullable=True),

        sa.Column('emergency_name', sa.String(length=160), nullable=True),
        sa.Column('emergency_relationship', sa.String(length=60), nullable=True),
        sa.Column('emergency_phone', sa.String(length=32), nullable=True),

        # Text, not String(n): these hold Fernet ciphertext, which is far longer
        # than the value it encrypts and would silently truncate in a bounded
        # column — producing a row that decrypts to nothing months later.
        sa.Column('pan_enc', sa.Text(), nullable=True),
        sa.Column('aadhaar_enc', sa.Text(), nullable=True),
        sa.Column('uan', sa.String(length=24), nullable=True),
        sa.Column('pf_number', sa.String(length=40), nullable=True),
        sa.Column('esi_number', sa.String(length=40), nullable=True),

        sa.Column('bank_name', sa.String(length=120), nullable=True),
        sa.Column('bank_branch', sa.String(length=120), nullable=True),
        sa.Column('bank_ifsc', sa.String(length=16), nullable=True),
        sa.Column('bank_account_enc', sa.Text(), nullable=True),
        sa.Column('bank_account_name', sa.String(length=160), nullable=True),

        sa.Column('employment_type', sa.String(length=20), nullable=True),
        sa.Column('work_location', sa.String(length=120), nullable=True),
        sa.Column('probation_months', sa.Integer(), nullable=True),
        sa.Column('probation_end_on', sa.Date(), nullable=True),
        sa.Column('confirmation_status', sa.String(length=20),
                  nullable=False, server_default='not_applicable'),
        sa.Column('confirmed_on', sa.Date(), nullable=True),
        sa.Column('confirmation_note', sa.Text(), nullable=True),

        sa.Column('bgv_status', sa.String(length=20), nullable=True),
        sa.Column('bgv_completed_on', sa.Date(), nullable=True),
        sa.Column('bgv_agency', sa.String(length=120), nullable=True),
        sa.Column('bgv_note', sa.Text(), nullable=True),

        sa.Column('updated_by', sa.Uuid(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),

        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        # SET NULL, not CASCADE: deleting the HR person who last edited a record
        # must not delete the record.
        sa.ForeignKeyConstraint(['updated_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('user_id'),
    )
    op.create_index('ix_employee_profiles_org_id', 'employee_profiles', ['org_id'])
    op.create_index('ix_employee_profiles_probation_end_on',
                    'employee_profiles', ['probation_end_on'])
    op.create_index('ix_employee_profiles_confirmation_status',
                    'employee_profiles', ['confirmation_status'])

    op.create_table(
        'employee_documents',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),

        sa.Column('doc_type', sa.String(length=60), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=True),

        sa.Column('storage_key', sa.String(length=500), nullable=False),
        sa.Column('file_name', sa.String(length=255), nullable=True),
        sa.Column('content_type', sa.String(length=120), nullable=True),
        sa.Column('file_size', sa.Integer(), nullable=False, server_default='0'),

        sa.Column('issued_on', sa.Date(), nullable=True),
        sa.Column('expires_on', sa.Date(), nullable=True),

        sa.Column('uploaded_by', sa.Uuid(), nullable=True),
        sa.Column('is_verified', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('verified_by', sa.Uuid(), nullable=True),
        sa.Column('verified_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('note', sa.Text(), nullable=True),

        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),

        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['uploaded_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['verified_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_employee_documents_org_id', 'employee_documents', ['org_id'])
    op.create_index('ix_employee_documents_user_id', 'employee_documents', ['user_id'])
    op.create_index('ix_employee_documents_user', 'employee_documents',
                    ['org_id', 'user_id', 'doc_type'])
    # The "what lapses soon" scan. Without it that report is a full table scan
    # per run, which is fine on a demo tenant and not on a real one.
    op.create_index('ix_employee_documents_expiry', 'employee_documents',
                    ['org_id', 'expires_on'])

    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('can_manage_people', sa.Boolean(), nullable=False,
                      server_default=sa.true())
        )


def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('can_manage_people')

    op.drop_index('ix_employee_documents_expiry', table_name='employee_documents')
    op.drop_index('ix_employee_documents_user', table_name='employee_documents')
    op.drop_index('ix_employee_documents_user_id', table_name='employee_documents')
    op.drop_index('ix_employee_documents_org_id', table_name='employee_documents')
    op.drop_table('employee_documents')

    op.drop_index('ix_employee_profiles_confirmation_status', table_name='employee_profiles')
    op.drop_index('ix_employee_profiles_probation_end_on', table_name='employee_profiles')
    op.drop_index('ix_employee_profiles_org_id', table_name='employee_profiles')
    op.drop_table('employee_profiles')
