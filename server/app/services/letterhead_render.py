"""Letters on the company letterhead, in one of five layouts.

Pure functions, like ``payslip_render``: the same code draws the live preview (placeholder lines) and
a real issued letter, so the letterhead an administrator designs is the one that prints.
"""

from __future__ import annotations

from html import escape

TEMPLATES = [
    ("classic", "Classic", "Logo beside the company block, accent rule under it. The default."),
    ("banded", "Banded", "Full-width colour band across the top, details reversed out in white."),
    ("stripe", "Stripe", "A colour bar down the left edge, header indented beside it."),
    ("formal", "Formal", "Everything centred under the logo, name in spaced caps, double rule."),
    ("minimal", "Minimal", "Small logo, details on one line opposite, no rule. Mostly white space."),
]

DEFAULTS = {
    "template": "classic", "company_name": "", "gstin": "", "address": "", "phone": "", "email": "",
    "accent": "#0f9488", "show_logo": True, "logo_pos": "left", "show_details": True, "details_pos": "left",
    "signatory_name": "", "signatory_designation": "", "show_signature": True, "signature_pos": "left",
    "show_footer": False, "footer_note": "", "border_on": False, "border_colour": "#cbd5e1",
    "border_thickness": "hairline", "border_margin": "normal",
    "watermark_on": False, "watermark_text": "CONFIDENTIAL", "watermark_strength": 6,
    "logo": None, "signature": None, "watermark_image": None,
}

SAMPLE = {"ref": "HR/OFR/0001", "date": "1 April 2026", "subject": "Offer of Employment", "body_html": None,
          "signatory_name": None, "signatory_title": None, "company": None}

_THICK = {"hairline": 1, "thin": 2, "medium": 3, "thick": 5}
_MARGIN = {"tight": 10, "normal": 18, "wide": 28}


def render(settings: dict, content: dict | None = None, template: str | None = None) -> str:
    s = {**DEFAULTS, **{k: v for k, v in (settings or {}).items() if v is not None}}
    c = {**SAMPLE, **(content or {})}
    tpl = template or s["template"]
    if tpl not in {t[0] for t in TEMPLATES}:
        tpl = "classic"
    a = s["accent"] or "#0f9488"
    company = s["company_name"] or c.get("company") or "Company name"

    logo = ""
    if s["show_logo"] and s.get("logo"):
        logo = f'<img class="logo" src="{s["logo"]}" alt="">'
    details = " · ".join(x for x in (s["address"], s["phone"], s["email"], f'GSTIN {s["gstin"]}' if s["gstin"] else "") if x)
    det = f'<div class="det">{escape(details)}</div>' if (s["show_details"] and details) else ""
    pos = {"left": "flex-start", "centre": "center", "right": "flex-end"}
    txt = {"left": "left", "centre": "center", "right": "right"}
    logo_just = pos.get(s["logo_pos"], "flex-start")
    det_align = txt.get(s["details_pos"], "left")

    name_html = f'<div class="nm">{escape(company)}</div>'
    if tpl == "classic":
        head = f'<div class="hd" style="justify-content:{logo_just}">{logo}<div>{name_html}{det}</div></div><div class="rule"></div><div class="rule2"></div>'
    elif tpl == "banded":
        head = f'<div class="band">{logo}<div>{name_html}{det}</div></div>'
    elif tpl == "stripe":
        head = f'<div class="hd" style="justify-content:{logo_just}">{logo}<div>{name_html}{det}</div></div><div class="short"></div>'
    elif tpl == "formal":
        head = (f'<div class="ctr">{logo}<div class="nm caps">{escape(company.upper())}</div>{det}</div>'
                '<div class="dbl"></div>')
    else:  # minimal
        head = f'<div class="mini">{logo}<b>{escape(company)}</b><span>{escape(details) if s["show_details"] else ""}</span></div>'
    head_style = f'text-align:{det_align};' if tpl in ("classic", "stripe") else ""

    if c.get("body_html"):
        body = c["body_html"]
    else:
        bars = [100, 94, 98, 60, 99, 90, 97, 62, 92, 98, 66]
        body = "".join(f'<div class="bar" style="width:{w}%"></div>' for w in bars)
    sig_name = c.get("signatory_name") or s["signatory_name"] or "Authorised Signatory"
    sig_title = c.get("signatory_title") or s["signatory_designation"]
    sig_img = f'<img class="simg" src="{s["signature"]}" alt="">' if (s["show_signature"] and s.get("signature")) else ""
    sig_side = "flex-end" if s["signature_pos"] == "right" else "flex-start"
    sign = (f'<div class="sg" style="align-items:{sig_side}">{sig_img}<div class="sline"></div><b>{escape(sig_name)}</b>'
            + (f'<span>{escape(sig_title)}</span>' if sig_title else "") + '</div>')
    foot = ""
    if s["show_footer"]:
        foot = f'<div class="ft" style="background:{a}">{escape(s["footer_note"] or "")}</div>'
    elif s["footer_note"]:
        foot = f'<div class="fn">{escape(s["footer_note"])}</div>'

    border = ""
    if s["border_on"]:
        m = _MARGIN.get(s["border_margin"], 18)
        border = (f'<div class="bd" style="inset:{m}px;border:{_THICK.get(s["border_thickness"], 1)}px solid '
                  f'{escape(s["border_colour"] or "#cbd5e1")}"></div>')
    wm = ""
    if s["watermark_on"]:
        op = max(0, min(int(s["watermark_strength"] or 6), 50)) / 100
        inner = (f'<img src="{s["watermark_image"]}" alt="" style="max-width:60%;opacity:{op}">' if s.get("watermark_image")
                 else f'<span style="opacity:{op}">{escape(s["watermark_text"] or "")}</span>')
        wm = f'<div class="wm">{inner}</div>'

    css = f"""
:root{{--a:{escape(a)}}} *{{box-sizing:border-box}} body{{margin:0;background:#eef2f6;font:11pt/1.6 'Poppins',Arial,sans-serif;color:#111827}}
.pg{{position:relative;max-width:760px;min-height:1000px;margin:20px auto;background:#fff;padding:56px 60px;overflow:hidden}}
.pg.stripe{{border-left:12px solid var(--a);padding-left:52px}} .pg.banded{{padding-top:0}}
.nm{{font-weight:700;font-size:15pt}} .caps{{letter-spacing:.25em;font-size:13pt}} .det{{font-size:8.5pt;color:#64748b;margin-top:2px}}
.hd{{display:flex;align-items:center;gap:14px}} .logo{{max-height:52px;max-width:150px}}
.rule{{border-top:2px solid var(--a);margin-top:14px}} .rule2{{border-top:1px solid #d9dee5;margin-top:3px}} .short{{width:60px;border-top:2px solid var(--a);margin-top:14px}}
.band{{background:var(--a);color:#fff;margin:0 -60px 0;padding:34px 60px;display:flex;align-items:center;gap:14px}} .band .det{{color:#e6f4f2}}
.ctr{{text-align:center;display:grid;justify-items:center;gap:4px}} .dbl{{border-top:3px double var(--a);margin-top:14px}}
.mini{{display:flex;justify-content:space-between;align-items:center;gap:16px;font-size:10pt}} .mini span{{font-size:8.5pt;color:#64748b}}
.meta{{display:flex;justify-content:space-between;font-size:8.5pt;color:#64748b;margin:46px 0 24px}} .subj{{text-align:center;font-weight:700;font-size:11pt;margin-bottom:22px}}
.bar{{height:7px;background:#e8edf1;border-radius:4px;margin:0 0 7px}} p{{margin:0 0 12px;text-align:justify}}
.sg{{display:flex;flex-direction:column;margin-top:120px;font-size:9pt}} .sline{{border-top:1px solid #94a3b8;width:210px;margin-bottom:6px}} .sg span{{color:#64748b}} .simg{{max-height:44px;max-width:180px;margin-bottom:-8px}}
.ft{{position:absolute;left:0;right:0;bottom:0;color:#fff;text-align:center;padding:10px;font-size:8.5pt}} .fn{{margin-top:36px;text-align:center;font-size:8pt;color:#64748b}}
.bd{{position:absolute;pointer-events:none}} .wm{{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:70pt;font-weight:800;transform:rotate(-24deg);pointer-events:none;color:#000}}
@media print{{body{{background:#fff}} .pg{{margin:0;max-width:none}}}}
"""
    cls = "pg " + tpl
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{escape(c['subject'] or 'Letter')}</title><style>{css}</style></head>
<body><div class="{cls}">{border}{wm}<div style="{head_style}">{head}</div>
<div class="meta"><span>Ref: {escape(c['ref'] or '')}</span><span>{escape(c['date'] or '')}</span></div>
<div class="subj">{escape(c['subject'] or '')}</div>{body}{sign}{foot}</div></body></html>"""
