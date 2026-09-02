"""workflow: conditional routing — a rule is a condition plus a whole chain

Revision ID: e8b3d5c14a09
Revises: d3f6a90c15b7
Create Date: 2026-09-01 16:40:00.000000

One new table and one nullable column, and **nothing existing changes meaning**.
Every ``workflow_levels`` row written before today gets ``rule_id = NULL``,
which is exactly what "the plain department chain" means to the resolver — so a
company that never writes a rule routes approvals precisely as it did.

The one thing that had to move is the unique constraint. It was
``(org_id, kind, department_id, level)``, and two rules for one flow both having
a level 1 is the entire point of rules — the second could not be inserted. It
becomes ``(org_id, kind, department_id, level, rule_id)``. NULLs repeat in a
unique index on both SQLite and Postgres, so the pre-rules rows keep exactly the
uniqueness they had.

``workflow_levels.rule_id`` cascades: a rung without its rule is a chain
fragment belonging to no condition, and deleting a rule is how a company removes
a route.

Downgrade drops the rules and, with them, the levels that belonged to one —
which is correct rather than lossy: those rungs describe a routing the older
code cannot perform.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e8b3d5c14a09'
down_revision: Union[str, None] = 'd3f6a90c15b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'workflow_rules',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('kind', sa.String(length=24), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('priority', sa.Integer(), nullable=False, server_default='100'),
        sa.Column('conditions', sa.JSON(), nullable=False),
        sa.Column('is_fallback', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE',
                                name=op.f('fk_workflow_rules_org_id_organizations')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_workflow_rules')),
    )
    op.create_index('ix_workflow_rules_org_id', 'workflow_rules', ['org_id'])
    op.create_index('ix_workflow_rules_org_kind', 'workflow_rules',
                    ['org_id', 'kind', 'priority'])

    with op.batch_alter_table('workflow_levels') as batch:
        batch.add_column(sa.Column('rule_id', sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            batch.f('fk_workflow_levels_rule_id_workflow_rules'),
            'workflow_rules', ['rule_id'], ['id'], ondelete='CASCADE',
        )
        batch.create_index('ix_workflow_levels_rule_id', ['rule_id'])
        # The constraint that had to grow a column — see the docstring.
        batch.drop_constraint('uq_workflow_levels_scope_level', type_='unique')
        batch.create_unique_constraint(
            'uq_workflow_levels_scope_level',
            ['org_id', 'kind', 'department_id', 'level', 'rule_id'],
        )


def downgrade() -> None:
    # The rungs belonging to a rule go first: without their rule they are a
    # chain fragment, and the restored constraint would reject them anyway.
    op.execute(sa.text('DELETE FROM workflow_levels WHERE rule_id IS NOT NULL'))

    with op.batch_alter_table('workflow_levels') as batch:
        batch.drop_constraint('uq_workflow_levels_scope_level', type_='unique')
        batch.create_unique_constraint(
            'uq_workflow_levels_scope_level',
            ['org_id', 'kind', 'department_id', 'level'],
        )
        batch.drop_index('ix_workflow_levels_rule_id')
        batch.drop_constraint(
            batch.f('fk_workflow_levels_rule_id_workflow_rules'), type_='foreignkey'
        )
        batch.drop_column('rule_id')

    op.drop_index('ix_workflow_rules_org_kind', table_name='workflow_rules')
    op.drop_index('ix_workflow_rules_org_id', table_name='workflow_rules')
    op.drop_table('workflow_rules')
