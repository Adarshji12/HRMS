"""Payroll checkpoint 4: investment declarations and the regime choice

Revision ID: a1c5e8f79b36
Revises: f9b4d7e68a25
Create Date: 2026-08-24 12:40:00.000000

Two new tables. All money is integer paise.

`tax_declarations` is unique on `(user_id, financial_year)`. A second row would
be two regime choices for one year, and nothing in the computation could pick
between them. `financial_year` is the year the FY *starts* — 2025 is FY 2025-26 —
the same convention `core.taxslabs` uses, so nothing converts between them.

`regime` is NOT NULL with a default of `new`, matching the default in law. "We do
not know" is not a state payroll can compute against, and defaulting silently to
the old regime would over-deduct from everybody who never filled the form in.

`tax_declaration_items` carries **both** a declared and a verified amount.
`verified_amount` is nullable and the null is load-bearing: it means nobody has
checked, which is different from zero, meaning checked and nothing stood up. An
employer honours the declaration until the proof deadline and the verified figure
after — collapsing the two columns loses the ability to say what changed when
somebody's TDS jumps in February.

`document_id` points into `employee_documents` rather than a second store, and is
SET NULL so deleting a proof does not delete the claim it evidenced.

The slab tables themselves are deliberately **not** here — see `core.taxslabs`
for why national law lives in code rather than in every tenant's database.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a1c5e8f79b36'
down_revision: Union[str, None] = 'f9b4d7e68a25'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'tax_declarations',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('financial_year', sa.Integer(), nullable=False),
        sa.Column('regime', sa.String(length=8), nullable=False, server_default='new'),
        sa.Column('status', sa.String(length=16), nullable=False,
                  server_default='draft'),
        sa.Column('submitted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('verified_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('verified_by', sa.Uuid(), nullable=True),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['verified_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'financial_year',
                            name='uq_tax_declarations_year'),
        sa.CheckConstraint('financial_year BETWEEN 2000 AND 2100',
                           name='ck_tax_declarations_year'),
    )
    op.create_index('ix_tax_declarations_org_id', 'tax_declarations', ['org_id'])
    op.create_index('ix_tax_declarations_user_id', 'tax_declarations', ['user_id'])
    op.create_index('ix_tax_declarations_org_year', 'tax_declarations',
                    ['org_id', 'financial_year', 'status'])

    op.create_table(
        'tax_declaration_items',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('declaration_id', sa.Uuid(), nullable=False),
        sa.Column('section', sa.String(length=24), nullable=False),
        sa.Column('label', sa.String(length=200), nullable=True),
        sa.Column('declared_amount', sa.Integer(), nullable=False, server_default='0'),
        # Nullable, and the null means "nobody has checked" — distinct from zero.
        sa.Column('verified_amount', sa.Integer(), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False,
                  server_default='declared'),
        sa.Column('document_id', sa.Uuid(), nullable=True),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['declaration_id'], ['tax_declarations.id'],
                                ondelete='CASCADE'),
        # SET NULL: deleting a proof must not delete the claim it evidenced.
        sa.ForeignKeyConstraint(['document_id'], ['employee_documents.id'],
                                ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('declaration_id', 'section', name='uq_tax_items_section'),
        sa.CheckConstraint(
            'declared_amount >= 0 AND (verified_amount IS NULL OR verified_amount >= 0)',
            name='ck_tax_items_amounts',
        ),
    )
    op.create_index('ix_tax_declaration_items_org_id', 'tax_declaration_items',
                    ['org_id'])
    op.create_index('ix_tax_items_declaration', 'tax_declaration_items',
                    ['declaration_id'])


def downgrade() -> None:
    op.drop_index('ix_tax_items_declaration', table_name='tax_declaration_items')
    op.drop_index('ix_tax_declaration_items_org_id', table_name='tax_declaration_items')
    op.drop_table('tax_declaration_items')

    op.drop_index('ix_tax_declarations_org_year', table_name='tax_declarations')
    op.drop_index('ix_tax_declarations_user_id', table_name='tax_declarations')
    op.drop_index('ix_tax_declarations_org_id', table_name='tax_declarations')
    op.drop_table('tax_declarations')
