"""crm: lead generation, customers, visits, quotations and reminders

Revision ID: c4a91b7e5d02
Revises: a2d67f04b9e1
Create Date: 2026-09-01 10:00:00.000000

Twenty-four new tables, all prefixed ``crm_``. Nothing existing is touched, no
column is added to any table another module owns, and nothing is backfilled —
the module is inert until a workspace's plan includes ``crm`` and somebody
opens the pipeline.

Two ordering facts worth knowing before editing this file:

* ``crm_customers`` is created **before** ``crm_leads``, because a lead carries
  ``customer_id`` — the pointer that marks it converted. The reverse pointer,
  ``crm_customers.converted_from_lead_id``, is deliberately a plain ``Uuid``
  with **no** foreign key, so there is no cycle to break. That is a design
  decision, not an omission; see the docstring on ``app.models.crm``.
* Every constraint is named, because SQLite cannot ALTER a table and Alembic's
  batch mode has to recreate them by name. The names come from the metadata
  naming convention in ``app.db.base``.

The masters (statuses, sources, dispositions, visit types, industries, and
India's states) are **not** seeded here. They are seeded per organisation on
first use by ``app.services.crm.ensure_defaults``, so a company that signs up
next year gets them too — a migration only reaches the workspaces that existed
when it ran.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c4a91b7e5d02'
down_revision: Union[str, None] = 'a2d67f04b9e1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('crm_counters',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('series', sa.String(length=24), nullable=False),
    sa.Column('period', sa.String(length=8), nullable=False),
    sa.Column('last_number', sa.Integer(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_counters_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_counters')),
    sa.UniqueConstraint('org_id', 'series', 'period', name='uq_crm_counters_org_series_period')
    )
    with op.batch_alter_table('crm_counters', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_counters_org_id'), ['org_id'], unique=False)
    op.create_table('crm_countries',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('iso2', sa.String(length=2), nullable=True),
    sa.Column('dial_code', sa.String(length=8), nullable=True),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_countries_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_countries')),
    sa.UniqueConstraint('org_id', 'name', name='uq_crm_countries_org_name')
    )
    with op.batch_alter_table('crm_countries', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_countries_org_id'), ['org_id'], unique=False)
    op.create_table('crm_dispositions',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('closes_interaction', sa.Boolean(), nullable=False),
    sa.Column('sort_order', sa.Integer(), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_dispositions_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_dispositions')),
    sa.UniqueConstraint('org_id', 'name', name='uq_crm_dispositions_org_name')
    )
    with op.batch_alter_table('crm_dispositions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_dispositions_org_id'), ['org_id'], unique=False)
    op.create_table('crm_industries',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_industries_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_industries')),
    sa.UniqueConstraint('org_id', 'name', name='uq_crm_industries_org_name')
    )
    with op.batch_alter_table('crm_industries', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_industries_org_id'), ['org_id'], unique=False)
    op.create_table('crm_lead_sources',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('is_intake_default', sa.Boolean(), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_lead_sources_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_lead_sources')),
    sa.UniqueConstraint('org_id', 'name', name='uq_crm_lead_sources_org_name')
    )
    with op.batch_alter_table('crm_lead_sources', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_lead_sources_org_id'), ['org_id'], unique=False)
    op.create_table('crm_lead_statuses',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('behaviour', sa.String(length=20), nullable=False),
    sa.Column('colour', sa.String(length=9), nullable=False),
    sa.Column('sort_order', sa.Integer(), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_lead_statuses_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_lead_statuses')),
    sa.UniqueConstraint('org_id', 'name', name='uq_crm_lead_statuses_org_name')
    )
    with op.batch_alter_table('crm_lead_statuses', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_lead_statuses_org_id'), ['org_id'], unique=False)
        batch_op.create_index('ix_crm_lead_statuses_org_sort', ['org_id', 'sort_order'], unique=False)
    op.create_table('crm_products',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=160), nullable=False),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('hsn_sac', sa.String(length=16), nullable=True),
    sa.Column('unit', sa.String(length=24), nullable=True),
    sa.Column('rate', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('gst_percent', sa.Numeric(precision=5, scale=2), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_products_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_products')),
    sa.UniqueConstraint('org_id', 'name', name='uq_crm_products_org_name')
    )
    with op.batch_alter_table('crm_products', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_products_org_id'), ['org_id'], unique=False)
    op.create_table('crm_reminders',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=160), nullable=False),
    sa.Column('message', sa.Text(), nullable=True),
    sa.Column('image_url', sa.String(length=500), nullable=True),
    sa.Column('template_name', sa.String(length=160), nullable=True),
    sa.Column('audience', sa.String(length=16), nullable=False),
    sa.Column('audience_filter', sa.JSON(), nullable=False),
    sa.Column('start_on', sa.Date(), nullable=False),
    sa.Column('end_on', sa.Date(), nullable=True),
    sa.Column('send_time', sa.String(length=5), nullable=False),
    sa.Column('weekdays', sa.JSON(), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('last_run_on', sa.Date(), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_reminders_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_reminders'))
    )
    with op.batch_alter_table('crm_reminders', schema=None) as batch_op:
        batch_op.create_index('ix_crm_reminders_org_active', ['org_id', 'is_active'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_reminders_org_id'), ['org_id'], unique=False)
    op.create_table('crm_visit_types',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('colour', sa.String(length=9), nullable=False),
    sa.Column('requires_otp', sa.Boolean(), nullable=False),
    sa.Column('sort_order', sa.Integer(), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_visit_types_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_visit_types')),
    sa.UniqueConstraint('org_id', 'name', name='uq_crm_visit_types_org_name')
    )
    with op.batch_alter_table('crm_visit_types', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_visit_types_org_id'), ['org_id'], unique=False)
    op.create_table('crm_plans',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('product_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('duration_days', sa.Integer(), nullable=True),
    sa.Column('price', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('gst_percent', sa.Numeric(precision=5, scale=2), nullable=True),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_plans_org_id_organizations'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['product_id'], ['crm_products.id'], name=op.f('fk_crm_plans_product_id_crm_products'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_plans')),
    sa.UniqueConstraint('org_id', 'product_id', 'name', name='uq_crm_plans_org_product_name')
    )
    with op.batch_alter_table('crm_plans', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_plans_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_plans_product_id'), ['product_id'], unique=False)
    op.create_table('crm_reminder_recipients',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('reminder_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=True),
    sa.Column('mobile', sa.String(length=24), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_reminder_recipients_org_id_organizations'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['reminder_id'], ['crm_reminders.id'], name=op.f('fk_crm_reminder_recipients_reminder_id_crm_reminders'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_reminder_recipients')),
    sa.UniqueConstraint('reminder_id', 'mobile', name='uq_crm_reminder_recipients_mobile')
    )
    with op.batch_alter_table('crm_reminder_recipients', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_reminder_recipients_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_reminder_recipients_reminder_id'), ['reminder_id'], unique=False)
    op.create_table('crm_reminder_runs',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('reminder_id', sa.Uuid(), nullable=False),
    sa.Column('run_on', sa.Date(), nullable=False),
    sa.Column('recipients', sa.Integer(), nullable=False),
    sa.Column('sent', sa.Integer(), nullable=False),
    sa.Column('failed', sa.Integer(), nullable=False),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_reminder_runs_org_id_organizations'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['reminder_id'], ['crm_reminders.id'], name=op.f('fk_crm_reminder_runs_reminder_id_crm_reminders'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_reminder_runs')),
    sa.UniqueConstraint('reminder_id', 'run_on', name='uq_crm_reminder_runs_reminder_day')
    )
    with op.batch_alter_table('crm_reminder_runs', schema=None) as batch_op:
        batch_op.create_index('ix_crm_reminder_runs_org_created', ['org_id', 'created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_reminder_runs_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_reminder_runs_reminder_id'), ['reminder_id'], unique=False)
    op.create_table('crm_states',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('country_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('gst_code', sa.String(length=2), nullable=True),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['country_id'], ['crm_countries.id'], name=op.f('fk_crm_states_country_id_crm_countries'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_states_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_states')),
    sa.UniqueConstraint('org_id', 'country_id', 'name', name='uq_crm_states_org_country_name')
    )
    with op.batch_alter_table('crm_states', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_states_country_id'), ['country_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_states_org_id'), ['org_id'], unique=False)
    op.create_table('crm_cities',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('state_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_cities_org_id_organizations'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['state_id'], ['crm_states.id'], name=op.f('fk_crm_cities_state_id_crm_states'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_cities')),
    sa.UniqueConstraint('org_id', 'state_id', 'name', name='uq_crm_cities_org_state_name')
    )
    with op.batch_alter_table('crm_cities', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_cities_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_cities_state_id'), ['state_id'], unique=False)
    op.create_table('crm_customers',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('code', sa.String(length=40), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('company', sa.String(length=200), nullable=True),
    sa.Column('mobile', sa.String(length=24), nullable=False),
    sa.Column('whatsapp', sa.String(length=24), nullable=True),
    sa.Column('email', sa.String(length=255), nullable=True),
    sa.Column('customer_type', sa.String(length=40), nullable=True),
    sa.Column('industry_id', sa.Uuid(), nullable=True),
    sa.Column('source_id', sa.Uuid(), nullable=True),
    sa.Column('gstin', sa.String(length=20), nullable=True),
    sa.Column('country_id', sa.Uuid(), nullable=True),
    sa.Column('state_id', sa.Uuid(), nullable=True),
    sa.Column('city_id', sa.Uuid(), nullable=True),
    sa.Column('pincode', sa.String(length=12), nullable=True),
    sa.Column('address', sa.Text(), nullable=True),
    sa.Column('manager_id', sa.Uuid(), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('converted_from_lead_id', sa.Uuid(), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['city_id'], ['crm_cities.id'], name=op.f('fk_crm_customers_city_id_crm_cities'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['country_id'], ['crm_countries.id'], name=op.f('fk_crm_customers_country_id_crm_countries'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['industry_id'], ['crm_industries.id'], name=op.f('fk_crm_customers_industry_id_crm_industries'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['manager_id'], ['users.id'], name=op.f('fk_crm_customers_manager_id_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_customers_org_id_organizations'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['source_id'], ['crm_lead_sources.id'], name=op.f('fk_crm_customers_source_id_crm_lead_sources'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['state_id'], ['crm_states.id'], name=op.f('fk_crm_customers_state_id_crm_states'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_customers')),
    sa.UniqueConstraint('org_id', 'code', name='uq_crm_customers_org_code')
    )
    with op.batch_alter_table('crm_customers', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_customers_org_id'), ['org_id'], unique=False)
        batch_op.create_index('ix_crm_customers_org_manager', ['org_id', 'manager_id'], unique=False)
        batch_op.create_index('ix_crm_customers_org_mobile', ['org_id', 'mobile'], unique=False)
        batch_op.create_index('ix_crm_customers_org_status', ['org_id', 'status'], unique=False)
    op.create_table('crm_settings',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('assignment_rule', sa.String(length=20), nullable=False),
    sa.Column('default_owner_id', sa.Uuid(), nullable=True),
    sa.Column('assignment_pool', sa.JSON(), nullable=False),
    sa.Column('assignment_cursor', sa.Integer(), nullable=False),
    sa.Column('intake_token', sa.String(length=64), nullable=True),
    sa.Column('intake_enabled', sa.Boolean(), nullable=False),
    sa.Column('quotation_prefix', sa.String(length=12), nullable=False),
    sa.Column('quotation_terms', sa.Text(), nullable=True),
    sa.Column('quotation_validity_days', sa.Integer(), nullable=False),
    sa.Column('visit_prefix', sa.String(length=12), nullable=False),
    sa.Column('ticket_prefix', sa.String(length=12), nullable=False),
    sa.Column('renewal_window_days', sa.Integer(), nullable=False),
    sa.Column('reminders_enabled', sa.Boolean(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['default_owner_id'], ['users.id'], name=op.f('fk_crm_settings_default_owner_id_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_settings_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_settings')),
    sa.UniqueConstraint('org_id', name='uq_crm_settings_org')
    )
    with op.batch_alter_table('crm_settings', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_settings_intake_token'), ['intake_token'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_settings_org_id'), ['org_id'], unique=False)
    op.create_table('crm_customer_plans',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('customer_id', sa.Uuid(), nullable=False),
    sa.Column('product_id', sa.Uuid(), nullable=True),
    sa.Column('plan_id', sa.Uuid(), nullable=True),
    sa.Column('product_name', sa.String(length=200), nullable=False),
    sa.Column('plan_name', sa.String(length=160), nullable=True),
    sa.Column('start_on', sa.Date(), nullable=False),
    sa.Column('end_on', sa.Date(), nullable=True),
    sa.Column('renewal_on', sa.Date(), nullable=True),
    sa.Column('amount', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('payment_status', sa.String(length=16), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['customer_id'], ['crm_customers.id'], name=op.f('fk_crm_customer_plans_customer_id_crm_customers'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_customer_plans_org_id_organizations'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['plan_id'], ['crm_plans.id'], name=op.f('fk_crm_customer_plans_plan_id_crm_plans'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['product_id'], ['crm_products.id'], name=op.f('fk_crm_customer_plans_product_id_crm_products'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_customer_plans'))
    )
    with op.batch_alter_table('crm_customer_plans', schema=None) as batch_op:
        batch_op.create_index('ix_crm_customer_plans_customer', ['customer_id', 'status'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_customer_plans_customer_id'), ['customer_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_customer_plans_org_id'), ['org_id'], unique=False)
        batch_op.create_index('ix_crm_customer_plans_org_renewal', ['org_id', 'renewal_on'], unique=False)
    op.create_table('crm_leads',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('code', sa.String(length=16), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('company', sa.String(length=200), nullable=True),
    sa.Column('mobile', sa.String(length=24), nullable=False),
    sa.Column('whatsapp', sa.String(length=24), nullable=True),
    sa.Column('email', sa.String(length=255), nullable=True),
    sa.Column('status_id', sa.Uuid(), nullable=True),
    sa.Column('source_id', sa.Uuid(), nullable=True),
    sa.Column('industry_id', sa.Uuid(), nullable=True),
    sa.Column('product_id', sa.Uuid(), nullable=True),
    sa.Column('owner_id', sa.Uuid(), nullable=True),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('state_id', sa.Uuid(), nullable=True),
    sa.Column('city_id', sa.Uuid(), nullable=True),
    sa.Column('pincode', sa.String(length=12), nullable=True),
    sa.Column('address', sa.Text(), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('value', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('next_follow_up_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_contacted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('customer_id', sa.Uuid(), nullable=True),
    sa.Column('converted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('lost_reason', sa.String(length=300), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['city_id'], ['crm_cities.id'], name=op.f('fk_crm_leads_city_id_crm_cities'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_crm_leads_created_by_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['customer_id'], ['crm_customers.id'], name=op.f('fk_crm_leads_customer_id_crm_customers'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['industry_id'], ['crm_industries.id'], name=op.f('fk_crm_leads_industry_id_crm_industries'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_leads_org_id_organizations'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], name=op.f('fk_crm_leads_owner_id_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['product_id'], ['crm_products.id'], name=op.f('fk_crm_leads_product_id_crm_products'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['source_id'], ['crm_lead_sources.id'], name=op.f('fk_crm_leads_source_id_crm_lead_sources'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['state_id'], ['crm_states.id'], name=op.f('fk_crm_leads_state_id_crm_states'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['status_id'], ['crm_lead_statuses.id'], name=op.f('fk_crm_leads_status_id_crm_lead_statuses'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_leads')),
    sa.UniqueConstraint('org_id', 'code', name='uq_crm_leads_org_code')
    )
    with op.batch_alter_table('crm_leads', schema=None) as batch_op:
        batch_op.create_index('ix_crm_leads_org_created', ['org_id', 'created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_leads_org_id'), ['org_id'], unique=False)
        batch_op.create_index('ix_crm_leads_org_mobile', ['org_id', 'mobile'], unique=False)
        batch_op.create_index('ix_crm_leads_org_next_followup', ['org_id', 'next_follow_up_at'], unique=False)
        batch_op.create_index('ix_crm_leads_org_owner', ['org_id', 'owner_id'], unique=False)
        batch_op.create_index('ix_crm_leads_org_status', ['org_id', 'status_id'], unique=False)
    op.create_table('crm_visits',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('visit_no', sa.String(length=24), nullable=False),
    sa.Column('customer_id', sa.Uuid(), nullable=False),
    sa.Column('visit_type_id', sa.Uuid(), nullable=True),
    sa.Column('visit_type_name', sa.String(length=120), nullable=True),
    sa.Column('contact_person', sa.String(length=200), nullable=True),
    sa.Column('mobile', sa.String(length=24), nullable=True),
    sa.Column('address', sa.Text(), nullable=True),
    sa.Column('priority', sa.String(length=12), nullable=False),
    sa.Column('purpose', sa.Text(), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('assigned_to', sa.Uuid(), nullable=True),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('scheduled_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('outcome', sa.Text(), nullable=True),
    sa.Column('otp_code', sa.String(length=8), nullable=True),
    sa.Column('otp_verified_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['assigned_to'], ['users.id'], name=op.f('fk_crm_visits_assigned_to_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_crm_visits_created_by_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['customer_id'], ['crm_customers.id'], name=op.f('fk_crm_visits_customer_id_crm_customers'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_visits_org_id_organizations'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['visit_type_id'], ['crm_visit_types.id'], name=op.f('fk_crm_visits_visit_type_id_crm_visit_types'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_visits')),
    sa.UniqueConstraint('org_id', 'visit_no', name='uq_crm_visits_org_visit_no')
    )
    with op.batch_alter_table('crm_visits', schema=None) as batch_op:
        batch_op.create_index('ix_crm_visits_customer', ['customer_id'], unique=False)
        batch_op.create_index('ix_crm_visits_org_employee_status', ['org_id', 'assigned_to', 'status'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_visits_org_id'), ['org_id'], unique=False)
        batch_op.create_index('ix_crm_visits_org_scheduled', ['org_id', 'scheduled_at'], unique=False)
    op.create_table('crm_activities',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('lead_id', sa.Uuid(), nullable=False),
    sa.Column('actor_id', sa.Uuid(), nullable=True),
    sa.Column('kind', sa.String(length=24), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['actor_id'], ['users.id'], name=op.f('fk_crm_activities_actor_id_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['lead_id'], ['crm_leads.id'], name=op.f('fk_crm_activities_lead_id_crm_leads'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_activities_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_activities'))
    )
    with op.batch_alter_table('crm_activities', schema=None) as batch_op:
        batch_op.create_index('ix_crm_activities_lead_created', ['lead_id', 'created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_activities_lead_id'), ['lead_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_activities_org_id'), ['org_id'], unique=False)
    op.create_table('crm_follow_ups',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('lead_id', sa.Uuid(), nullable=True),
    sa.Column('customer_id', sa.Uuid(), nullable=True),
    sa.Column('owner_id', sa.Uuid(), nullable=True),
    sa.Column('due_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('purpose', sa.String(length=300), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('outcome', sa.Text(), nullable=True),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['customer_id'], ['crm_customers.id'], name=op.f('fk_crm_follow_ups_customer_id_crm_customers'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['lead_id'], ['crm_leads.id'], name=op.f('fk_crm_follow_ups_lead_id_crm_leads'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_follow_ups_org_id_organizations'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], name=op.f('fk_crm_follow_ups_owner_id_users'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_follow_ups'))
    )
    with op.batch_alter_table('crm_follow_ups', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_follow_ups_customer_id'), ['customer_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_follow_ups_lead_id'), ['lead_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_follow_ups_org_id'), ['org_id'], unique=False)
        batch_op.create_index('ix_crm_follow_ups_org_owner_due', ['org_id', 'owner_id', 'due_at'], unique=False)
        batch_op.create_index('ix_crm_follow_ups_org_status_due', ['org_id', 'status', 'due_at'], unique=False)
    op.create_table('crm_quotations',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('number', sa.String(length=32), nullable=False),
    sa.Column('lead_id', sa.Uuid(), nullable=True),
    sa.Column('customer_id', sa.Uuid(), nullable=True),
    sa.Column('customer_name', sa.String(length=200), nullable=True),
    sa.Column('company', sa.String(length=200), nullable=True),
    sa.Column('gstin', sa.String(length=20), nullable=True),
    sa.Column('mobile', sa.String(length=24), nullable=True),
    sa.Column('whatsapp', sa.String(length=24), nullable=True),
    sa.Column('email', sa.String(length=255), nullable=True),
    sa.Column('city', sa.String(length=120), nullable=True),
    sa.Column('state', sa.String(length=120), nullable=True),
    sa.Column('pincode', sa.String(length=12), nullable=True),
    sa.Column('billing_address', sa.Text(), nullable=True),
    sa.Column('shipping_address', sa.Text(), nullable=True),
    sa.Column('quote_date', sa.Date(), nullable=False),
    sa.Column('valid_until', sa.Date(), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('sub_total', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('discount_total', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('taxable_value', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('cgst', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('sgst', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('igst', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('grand_total', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('is_interstate', sa.Boolean(), nullable=False),
    sa.Column('terms', sa.Text(), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_crm_quotations_created_by_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['customer_id'], ['crm_customers.id'], name=op.f('fk_crm_quotations_customer_id_crm_customers'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['lead_id'], ['crm_leads.id'], name=op.f('fk_crm_quotations_lead_id_crm_leads'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_quotations_org_id_organizations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_quotations')),
    sa.UniqueConstraint('org_id', 'number', name='uq_crm_quotations_org_number')
    )
    with op.batch_alter_table('crm_quotations', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_quotations_customer_id'), ['customer_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_quotations_lead_id'), ['lead_id'], unique=False)
        batch_op.create_index('ix_crm_quotations_org_date', ['org_id', 'quote_date'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_quotations_org_id'), ['org_id'], unique=False)
        batch_op.create_index('ix_crm_quotations_org_status', ['org_id', 'status'], unique=False)
    op.create_table('crm_interactions',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('ticket_no', sa.String(length=24), nullable=False),
    sa.Column('customer_id', sa.Uuid(), nullable=False),
    sa.Column('direction', sa.String(length=12), nullable=False),
    sa.Column('disposition_id', sa.Uuid(), nullable=True),
    sa.Column('disposition_name', sa.String(length=120), nullable=True),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('remarks', sa.Text(), nullable=True),
    sa.Column('staff_id', sa.Uuid(), nullable=True),
    sa.Column('follow_up_id', sa.Uuid(), nullable=True),
    sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['customer_id'], ['crm_customers.id'], name=op.f('fk_crm_interactions_customer_id_crm_customers'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['disposition_id'], ['crm_dispositions.id'], name=op.f('fk_crm_interactions_disposition_id_crm_dispositions'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['follow_up_id'], ['crm_follow_ups.id'], name=op.f('fk_crm_interactions_follow_up_id_crm_follow_ups'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_interactions_org_id_organizations'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['staff_id'], ['users.id'], name=op.f('fk_crm_interactions_staff_id_users'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_interactions')),
    sa.UniqueConstraint('org_id', 'ticket_no', name='uq_crm_interactions_org_ticket')
    )
    with op.batch_alter_table('crm_interactions', schema=None) as batch_op:
        batch_op.create_index('ix_crm_interactions_customer_created', ['customer_id', 'created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_interactions_customer_id'), ['customer_id'], unique=False)
        batch_op.create_index('ix_crm_interactions_org_created', ['org_id', 'created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_interactions_org_id'), ['org_id'], unique=False)
        batch_op.create_index('ix_crm_interactions_org_status', ['org_id', 'status'], unique=False)
    op.create_table('crm_quotation_lines',
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('quotation_id', sa.Uuid(), nullable=False),
    sa.Column('product_id', sa.Uuid(), nullable=True),
    sa.Column('plan_id', sa.Uuid(), nullable=True),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('hsn_sac', sa.String(length=16), nullable=True),
    sa.Column('quantity', sa.Numeric(precision=12, scale=3), nullable=False),
    sa.Column('rate', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('discount', sa.Numeric(precision=12, scale=2), nullable=False),
    sa.Column('discount_is_percent', sa.Boolean(), nullable=False),
    sa.Column('gst_percent', sa.Numeric(precision=5, scale=2), nullable=False),
    sa.Column('taxable_value', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('tax_amount', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('amount', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('sort_order', sa.Integer(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_crm_quotation_lines_org_id_organizations'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['plan_id'], ['crm_plans.id'], name=op.f('fk_crm_quotation_lines_plan_id_crm_plans'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['product_id'], ['crm_products.id'], name=op.f('fk_crm_quotation_lines_product_id_crm_products'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['quotation_id'], ['crm_quotations.id'], name=op.f('fk_crm_quotation_lines_quotation_id_crm_quotations'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_crm_quotation_lines'))
    )
    with op.batch_alter_table('crm_quotation_lines', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crm_quotation_lines_org_id'), ['org_id'], unique=False)
        batch_op.create_index('ix_crm_quotation_lines_quotation', ['quotation_id', 'sort_order'], unique=False)
        batch_op.create_index(batch_op.f('ix_crm_quotation_lines_quotation_id'), ['quotation_id'], unique=False)


def downgrade() -> None:
    op.drop_table('crm_quotation_lines')
    op.drop_table('crm_interactions')
    op.drop_table('crm_quotations')
    op.drop_table('crm_follow_ups')
    op.drop_table('crm_activities')
    op.drop_table('crm_visits')
    op.drop_table('crm_leads')
    op.drop_table('crm_customer_plans')
    op.drop_table('crm_settings')
    op.drop_table('crm_customers')
    op.drop_table('crm_cities')
    op.drop_table('crm_states')
    op.drop_table('crm_reminder_runs')
    op.drop_table('crm_reminder_recipients')
    op.drop_table('crm_plans')
    op.drop_table('crm_visit_types')
    op.drop_table('crm_reminders')
    op.drop_table('crm_products')
    op.drop_table('crm_lead_statuses')
    op.drop_table('crm_lead_sources')
    op.drop_table('crm_industries')
    op.drop_table('crm_dispositions')
    op.drop_table('crm_countries')
    op.drop_table('crm_counters')
