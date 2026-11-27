"""The Roles screen lists the console's menus, so the two must not drift apart.

The sidebar (admin/src/lib/nav.tsx) is the source of truth for which pages exist. A page added there with no row in
``core.menus`` cannot be switched on or off for a role, and a row left behind for a page that has been removed is a
static tab nobody can find in the console. This test fails the moment either happens.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.core import menus

NAV = Path(__file__).resolve().parents[2] / "admin" / "src" / "lib" / "nav.tsx"

#: Pages that are in the sidebar but are not a menu of their own: the HR landing page simply lists the other HR menus.
NAV_ONLY = {"/hrms"}
#: Menus with no sidebar row of their own: a parent row that groups its children, or a page opened from another page.
MENU_ONLY = {"/", "/masters", "/departments", "/designations"}


def _nav_routes() -> set[str]:
    text = NAV.read_text(encoding="utf-8")
    return set(re.findall(r"\bto: '(/[^']*)'", text)) - {"/"}


def test_every_sidebar_page_is_on_the_roles_screen():
    known = {m.key for m in menus.MENUS} | {a for m in menus.MENUS for a in m.aliases}
    missing = sorted(r for r in _nav_routes() - NAV_ONLY if r not in known)
    assert not missing, f"In the sidebar but not in core/menus.py: {missing}"


def test_every_roles_screen_row_is_a_page_in_the_sidebar():
    routes = _nav_routes()
    stale = sorted(m.key for m in menus.MENUS if m.key not in routes and m.key not in MENU_ONLY and m.parent is None)
    assert not stale, f"In core/menus.py but no longer in the sidebar: {stale}"
    for m in menus.MENUS:
        if m.parent is not None:
            assert m.parent in {x.key for x in menus.MENUS}, m.key


def test_a_role_saved_under_an_old_menu_name_keeps_its_rights_under_the_new_one():
    saved = {"/erp/billing": {"access": True, "add": True, "edit": False, "delete": False},
             "/noticeboard": {"access": True}, "/settings/leave": {"access": True, "edit": True}}
    now = menus.normalise(saved)
    assert now["/erp/invoices"]["add"] is True and now["/hrms/settings"]["edit"] is True
    assert "/noticeboard" not in now and "/erp/billing" not in now
    # A row the role already has under the new key is not overwritten by the old one.
    kept = menus.normalise({"/erp/billing": {"access": True}, "/erp/invoices": {"access": False}})
    assert kept["/erp/invoices"]["access"] is False
    assert menus.normalise(None) is None


def test_menu_levels_match_the_console_and_lock_what_a_role_cannot_use():
    """teamOnly / adminOnly / ownerOnly in the sidebar are the menu's level; the Roles screen locks rows above a role's."""
    text = NAV.read_text(encoding="utf-8")
    want: dict[str, str] = {}
    for body, route in re.findall(r"\{([^{}]*?\bto: '(/[^']*)'[^{}]*?)\}", text):
        for flag, level in (("ownerOnly", "owner"), ("adminOnly", "admin"), ("teamOnly", "team")):
            if re.search(rf"\b{flag}\b", body):
                want[route] = level
                break
    for route, level in want.items():
        menu = menus.BY_KEY.get(route)
        assert menu is not None and menu.level == level, (route, level, menu and menu.level)

    assert menus.level_allowed(None, "employee", "self")
    assert not menus.level_allowed("team", "employee", "self") and menus.level_allowed("team", "employee", "team")
    assert menus.level_allowed("team", "manager", "self") and not menus.level_allowed("admin", "manager", "team")
    assert menus.level_allowed("admin", "admin", "company") and not menus.level_allowed("owner", "admin", "company")

    ticked = {m.key: {"access": True} for m in menus.MENUS}
    standard = menus.clean_menu_rights(ticked, "employee", "self")
    assert standard["/roles"]["access"] is False and standard["/employees"]["access"] is False
    assert standard["/home"]["access"] is True and standard["/helpdesk"]["access"] is True
    team = menus.clean_menu_rights(ticked, "employee", "team")
    assert team["/employees"]["access"] is True and team["/roles"]["access"] is False
