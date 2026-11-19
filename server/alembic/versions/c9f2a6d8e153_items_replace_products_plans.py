"""ERP items replace the CRM product and plan masters

Revision ID: c9f2a6d8e153
Revises: b8e3f5a1c704

A lead, a quotation line and a customer plan used to point at ``crm_products``
(and a plan at ``crm_plans``). They now point at ``erp_items``, the one
catalogue. Every CRM product becomes an item first -- reusing the item it was
already linked to, or creating one -- so no lead, quotation or customer plan
loses what it referred to. Plans have no replacement: a customer plan keeps its
typed start, end and renewal dates and the free-text plan label it was saved
with.

Not reversible: the product and plan tables are dropped.
"""

import datetime as dt
import uuid
from decimal import Decimal

import sqlalchemy as sa
from alembic import op

revision = "c9f2a6d8e153"
down_revision = "b8e3f5a1c704"
branch_labels = None
depends_on = None

#: (table, column) pairs that held a crm_products id and now hold an erp_items id.
REFERRERS = (
    ("crm_leads", "product_id"),
    ("crm_customer_plans", "product_id"),
    ("crm_quotation_lines", "product_id"),
)
CONVENTION = {"fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s"}


def _fk_name(inspector, table: str, column: str, referred: str) -> str:
    """The foreign key's name: the real one on PostgreSQL, a derived one on SQLite
    (which stores them unnamed; the naming convention below names them on reflect)."""
    for fk in inspector.get_foreign_keys(table):
        if fk["constrained_columns"] == [column] and fk["referred_table"] == referred:
            return fk["name"] or f"fk_{table}_{column}_{referred}"
    return f"fk_{table}_{column}_{referred}"


def _fill(table: sa.Table, values: dict) -> dict:
    """Give every NOT NULL column without a value a neutral one, so the insert
    survives a column this migration does not know about."""
    now = dt.datetime.now(dt.timezone.utc)
    for col in table.columns:
        if col.name in values or col.nullable:
            continue
        kind = col.type
        if isinstance(kind, sa.Boolean):
            values[col.name] = False
        elif isinstance(kind, (sa.Integer, sa.Numeric)):
            values[col.name] = Decimal("0") if isinstance(kind, sa.Numeric) else 0
        elif isinstance(kind, sa.DateTime):
            values[col.name] = now
        elif isinstance(kind, (sa.String, sa.Text)):
            values[col.name] = ""
    return values


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    meta = sa.MetaData()
    # Uuid columns are declared rather than reflected: SQLite reflects them as
    # CHAR(32) and would refuse a uuid.UUID value.
    products = sa.Table(
        "crm_products", meta,
        sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("org_id", sa.Uuid()),
        autoload_with=bind,
    )
    items = sa.Table(
        "erp_items", meta,
        sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("org_id", sa.Uuid()),
        sa.Column("crm_product_id", sa.Uuid()),
        autoload_with=bind,
    )

    # 1. Every product gets an item. An item already linked to it is reused.
    linked = {
        row.crm_product_id for row in bind.execute(
            sa.select(items.c.crm_product_id).where(items.c.crm_product_id.is_not(None))
        )
    }
    taken: dict = {}
    for row in bind.execute(sa.select(items.c.org_id, items.c.code)):
        taken.setdefault(row.org_id, set()).add(row.code)

    for product in bind.execute(sa.select(products).order_by(products.c.created_at)):
        if product.id in linked:
            continue
        codes = taken.setdefault(product.org_id, set())
        number = len(codes) + 1
        while f"PRD-{number:04d}" in codes:
            number += 1
        code = f"PRD-{number:04d}"
        codes.add(code)
        is_service = (product.category or "product") != "product"
        now = dt.datetime.now(dt.timezone.utc)
        values = {
            "id": uuid.uuid4(), "org_id": product.org_id, "code": code,
            "name": product.name, "description": product.description,
            "item_type": "service" if is_service else "goods",
            "uom": product.unit or ("Service" if is_service else "Nos"),
            "hsn_sac": product.hsn_sac, "gst_percent": product.gst_percent,
            "purchase_gst_percent": product.gst_percent, "make": product.oem, "sale_price": product.rate,
            "can_be_sold": True, "can_be_purchased": not is_service,
            "track_inventory": not is_service, "is_active": product.is_active,
            "crm_product_id": product.id, "created_at": now,
        }
        if "updated_at" in items.c:
            values["updated_at"] = now
        bind.execute(items.insert().values(**_fill(items, values)))

    # 2. Re-point the three referrers: drop the old key, translate the id, add the new key.
    for table, column in REFERRERS:
        name = _fk_name(inspector, table, column, "crm_products")
        with op.batch_alter_table(table, naming_convention=CONVENTION) as batch:
            batch.drop_constraint(name, type_="foreignkey")
        op.execute(
            f"UPDATE {table} SET {column} = (SELECT erp_items.id FROM erp_items "
            f"WHERE erp_items.crm_product_id = {table}.{column}) "
            f"WHERE {column} IS NOT NULL"
        )
        with op.batch_alter_table(table, naming_convention=CONVENTION) as batch:
            batch.create_foreign_key(
                f"fk_{table}_{column}_erp_items", "erp_items", [column], ["id"], ondelete="SET NULL"
            )

    # 3. Plans are gone: drop their references, then the tables.
    for table in ("crm_customer_plans", "crm_quotation_lines"):
        with op.batch_alter_table(table, naming_convention=CONVENTION) as batch:
            batch.drop_column("plan_id")
    with op.batch_alter_table("erp_items", naming_convention=CONVENTION) as batch:
        batch.drop_column("crm_product_id")
    op.drop_table("crm_plans")
    op.drop_table("crm_products")


def downgrade() -> None:
    raise RuntimeError(
        "Irreversible: the CRM product and plan masters were replaced by ERP items. "
        "Restore the database backup taken before this migration."
    )
