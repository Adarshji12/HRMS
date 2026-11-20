"""The payslip as a printable page, in one of five layouts, from the company's design settings.

Pure functions: a settings dict and a data dict in, HTML out. The same code draws the live preview
(sample data) and a real payslip, so what the administrator sees while designing is what is printed.
"""

from __future__ import annotations

from html import escape

TEMPLATES = [
    ("corporate", "Corporate", "Two columns, ruled table, company block top-left. The default."),
    ("modern", "Modern", "Coloured header band, borderless rows, generous spacing."),
    ("professional", "Professional", "Boxed sections with a summary panel down the right."),
    ("detailed", "Detailed", "Adds attendance, leave, PF/ESIC wages and year-to-date figures."),
    ("executive", "Executive", "Minimal, wide margins, net pay set large. Nothing but the numbers."),
]

DEFAULTS = {
    "template": "corporate", "company_name": "", "cin": "", "address": "", "phone": "", "email": "",
    "accent": "#0f6b63", "pan": "", "tan": "", "pf_code": "", "esic_code": "", "lwf_code": "",
    "signatory_name": "", "signatory_designation": "", "footer_note": "",
    "show_bank": True, "show_ids": True, "show_attendance": True,
    "watermark_on": False, "watermark_text": "CONFIDENTIAL", "watermark_strength": 6,
    "logo": None, "signature": None, "watermark_image": None,
}

SAMPLE = {
    "period": "September 2026", "ref": "EMP-0001 / SEP-2026",
    "employee": {"name": "Ankush Thakur", "code": "EMP-0001", "designation": "Regional Sales Manager",
                 "department": "Sales & Distribution", "doj": "12 Apr 2021", "pan": "ABCDE1234F",
                 "uan": "100234567890", "bank": "HDFC Bank · 50100234456721", "ifsc": "HDFC0001234"},
    "paid_days": 30, "month_days": 30,
    "attendance": {"Working": 30, "Present": 26, "Paid": 30, "Leave": 2, "Week off": 4, "Holiday": 1, "LOP": 0},
    "earnings": [("Basic Salary", 2400000), ("House Rent Allowance", 960000), ("Conveyance Allowance", 160000),
                 ("Special Allowance", 480000)],
    "deductions": [("Provident Fund", 288000), ("Professional Tax", 20000), ("TDS", 125000)],
    "employer": [("Employer PF", 288000)],
    "gross": 4000000, "total_deductions": 433000, "net": 3567000,
    "ytd": {"Gross earnings": 24000000, "Deductions": 2598000, "Net paid": 21402000},
    "note": None,
}


def money(paise: int) -> str:
    return f"{paise / 100:,.2f}"


_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
         "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _below_thousand(n: int) -> str:
    out = []
    if n >= 100:
        out.append(_ONES[n // 100] + " Hundred")
        n %= 100
    if n >= 20:
        out.append(_TENS[n // 10] + ((" " + _ONES[n % 10]) if n % 10 else ""))
    elif n:
        out.append(_ONES[n])
    return " ".join(out)


def words(paise: int) -> str:
    """Indian numbering: lakh and crore."""
    rupees, ps = divmod(max(paise, 0), 100)
    if rupees == 0 and ps == 0:
        return "Zero Rupees Only"
    parts = []
    for size, name in ((10_000_000, "Crore"), (100_000, "Lakh"), (1000, "Thousand")):
        if rupees >= size:
            parts.append(_below_thousand(rupees // size) + " " + name)
            rupees %= size
    if rupees:
        parts.append(_below_thousand(rupees))
    text = " ".join(parts) + " Rupees" if parts else ""
    if ps:
        text += (" and " if text else "") + _below_thousand(ps) + " Paise"
    return text + " Only"


def _e(value) -> str:
    return escape(str(value)) if value not in (None, "") else "—"


def _rows(items) -> str:
    return "".join(f'<tr><td>{escape(n)}</td><td class="num">{money(a)}</td></tr>' for n, a in items)


def _grid(pairs, cols: int = 2) -> str:
    cells = "".join(f'<div class="k">{escape(k)}</div><div class="v">{_e(v)}</div>' for k, v in pairs)
    return f'<div class="grid g{cols}">{cells}</div>'


def _attendance(att: dict) -> str:
    if not att:
        return ""
    head = "".join(f"<th>{escape(k)}</th>" for k in att)
    vals = "".join(f"<td>{v}</td>" for v in att.values())
    return f'<table class="att"><thead><tr>{head}</tr></thead><tbody><tr>{vals}</tr></tbody></table>'


def _tables(d, *, heads=("Earnings", "Deductions")) -> str:
    return f"""<div class="cols">
<table class="ed"><thead><tr><th>{heads[0]}</th><th class="num">Amount (INR)</th></tr></thead><tbody>{_rows(d['earnings'])}
<tr class="tot"><td>Gross earnings</td><td class="num">{money(d['gross'])}</td></tr></tbody></table>
<table class="ed"><thead><tr><th>{heads[1]}</th><th class="num">Amount (INR)</th></tr></thead><tbody>{_rows(d['deductions']) or '<tr><td colspan="2">None</td></tr>'}
<tr class="tot"><td>Total deductions</td><td class="num">{money(d['total_deductions'])}</td></tr></tbody></table>
</div>"""


def _sign(s) -> str:
    sig = f'<img class="sigimg" src="{s["signature"]}" alt="">' if s.get("signature") else ""
    who = escape(s["signatory_name"] or "Authorised Signatory")
    des = f'<div class="sub">{escape(s["signatory_designation"])}</div>' if s["signatory_designation"] else ""
    return f"""<div class="sign"><div><div class="line"></div>Employee signature</div>
<div>{sig}<div class="line"></div><b>{who}</b>{des}</div></div>"""


def render(settings: dict, data: dict | None = None, template: str | None = None) -> str:
    s = {**DEFAULTS, **{k: v for k, v in (settings or {}).items() if v is not None}}
    d = data or SAMPLE
    tpl = template or s["template"]
    if tpl not in {t[0] for t in TEMPLATES}:
        tpl = "corporate"
    emp = d["employee"]
    company = s["company_name"] or d.get("company") or "Company name"
    accent = s["accent"] or "#0f6b63"
    ids_on, bank_on = s["show_ids"], s["show_bank"]
    att_on = s["show_attendance"] and d.get("attendance")

    logo = f'<img class="logo" src="{s["logo"]}" alt="">' if s.get("logo") else ""
    sub = " · ".join(x for x in (s["address"], s["phone"], s["email"]) if x)
    sub_html = f'<div class="sub">{escape(sub)}</div>' if sub else ""
    ids = " · ".join(f"{label} {val}" for label, val in
                     (("PAN", s["pan"]), ("TAN", s["tan"]), ("PF Est.", s["pf_code"]), ("ESIC", s["esic_code"]),
                      ("LWF", s["lwf_code"]), ("CIN", s["cin"])) if val)
    ids_html = f'<div class="sub">{escape(ids)}</div>' if ids else ""
    company_block = f'<div class="co">{logo}<div><div class="name">{escape(company)}</div>{sub_html}{ids_html}</div></div>'

    base_pairs = [("Employee Name", emp["name"]), ("Employee Code", emp["code"]),
                  ("Designation", emp["designation"]), ("Department", emp["department"]),
                  ("Date of Joining", emp["doj"]), ("Paid Days", f"{d['paid_days']} of {d['month_days']}")]
    if ids_on:
        base_pairs += [("PAN", emp.get("pan")), ("UAN", emp.get("uan"))]
    if bank_on:
        base_pairs += [("Bank Account", emp.get("bank")), ("IFSC", emp.get("ifsc"))]

    net_words = words(d["net"])
    footer = escape(s["footer_note"]) if s["footer_note"] else ""
    foot = f'<div class="foot">{footer}<div>This is a computer-generated payslip and does not require a physical signature.</div></div>'
    note = f'<div class="note">{escape(d["note"])}</div>' if d.get("note") else ""
    employer = ""
    if d.get("employer"):
        employer = (f'<table class="ed"><thead><tr><th>Employer contributions</th><th class="num">Amount (INR)</th></tr></thead><tbody>'
                    f'{_rows(d["employer"])}</tbody></table>')
    ytd = ""
    if d.get("ytd"):
        ytd = ('<table class="ed"><thead><tr><th>Year to date (INR)</th><th class="num">Amount</th></tr></thead><tbody>'
               + "".join(f'<tr><td>{escape(k)}</td><td class="num">{money(v)}</td></tr>' for k, v in d["ytd"].items())
               + '</tbody></table>')

    # --- the five bodies -----------------------------------------------------
    if tpl == "modern":
        body = f"""<div class="band">{company_block}<div class="bandr"><div class="tag">PAYSLIP</div><b>{escape(d['period'])}</b></div></div>
<div class="pad"><div class="cards">{"".join(f'<div class="card"><div class="k">{escape(k)}</div><div class="v">{_e(v)}</div></div>' for k, v in base_pairs[:2] + base_pairs[2:3] + base_pairs[5:6])}</div>
{_tables(d)}
<div class="netpanel"><div class="k">NET PAY FOR THIS PERIOD</div><div class="big">Rs. {money(d['net'])}</div>
<div class="row"><span>{escape(net_words)}</span><span>Gross {money(d['gross'])} · Deductions {money(d['total_deductions'])}</span></div></div>
{_attendance(d['attendance']) if att_on else ''}{note}{_sign(s)}{foot}</div>"""
    elif tpl == "professional":
        body = f"""<div class="head">{company_block}</div>
<div class="split"><div>{_grid(base_pairs[:6], 1)}
<table class="ed"><thead><tr><th>Earnings</th><th class="num">Amount (INR)</th></tr></thead><tbody>{_rows(d['earnings'])}<tr class="tot"><td>Gross earnings</td><td class="num">{money(d['gross'])}</td></tr></tbody></table>
<table class="ed"><thead><tr><th>Deductions</th><th class="num">Amount (INR)</th></tr></thead><tbody>{_rows(d['deductions']) or '<tr><td colspan="2">None</td></tr>'}<tr class="tot"><td>Total deductions</td><td class="num">{money(d['total_deductions'])}</td></tr></tbody></table>
<div class="words"><span class="k">Amount in words:</span> {escape(net_words)}</div></div>
<aside class="panel"><div class="tag">PAYSLIP</div><b>{escape(d['period'])}</b><div class="k">NET PAY</div><div class="big">Rs. {money(d['net'])}</div>
<div class="row"><span>Gross earnings</span><b>{money(d['gross'])}</b></div><div class="row"><span>Total deductions</span><b>{money(d['total_deductions'])}</b></div>
<div class="row"><span>Paid days</span><b>{d['paid_days']} / {d['month_days']}</b></div>
{f'<div class="k">BANK</div><b>{_e(emp.get("bank"))}</b>' if bank_on else ''}</aside></div>
{_attendance(d['attendance']) if att_on else ''}{note}{_sign(s)}{foot}"""
    elif tpl == "executive":
        body = f"""<div class="exh">{logo}<div class="exco">{escape(company.upper())}</div></div><div class="exrule"></div>
<div class="exrow"><span class="tag">PAYSLIP</span><span class="tag">{escape(d['period'].upper())}</span></div>
<div class="exname">{escape(emp['name'])}</div><div class="sub">{escape(' · '.join(x for x in (emp['designation'], emp['department'], emp['code']) if x))}</div>
<div class="k" style="margin-top:36px">NET PAY</div><div class="exnet">Rs. {money(d['net'])}</div><div class="sub"><i>{escape(net_words)}</i></div>
<div class="exrule"></div>
<div class="cols exc"><div><div class="tag">EARNINGS</div><table class="ed"><tbody>{_rows(d['earnings'])}<tr class="tot"><td>Total</td><td class="num">{money(d['gross'])}</td></tr></tbody></table></div>
<div><div class="tag">DEDUCTIONS</div><table class="ed"><tbody>{_rows(d['deductions'])}<tr class="tot"><td>Total</td><td class="num">{money(d['total_deductions'])}</td></tr></tbody></table></div></div>
{_attendance(d['attendance']) if att_on else ''}{note}{_sign(s)}{foot}"""
    else:  # corporate and detailed
        detailed = tpl == "detailed"
        pairs = base_pairs if not detailed else base_pairs
        body = f"""<div class="head">{company_block}<div class="hr"><div class="tag">PAYSLIP</div><b class="per">{escape(d['period'])}</b><div class="sub">Ref: {escape(d['ref'])}</div></div></div>
<div class="rule"></div><div class="banner">SALARY SLIP FOR {escape(d['period'].upper())}</div>
{_grid(pairs, 3 if detailed else 2)}
{_attendance(d['attendance']) if att_on else ''}
{_tables(d)}
{f'<div class="cols">{employer}{ytd}</div>' if detailed and (employer or ytd) else ''}
<div class="netbar"><span>NET PAYABLE</span><b>Rs. {money(d['net'])}</b></div>
<div class="words"><span class="k">Amount in words:</span> <b>{escape(net_words)}</b></div>
{note}{_sign(s)}{foot}"""

    wm = ""
    if s["watermark_on"]:
        op = max(0, min(int(s["watermark_strength"] or 6), 50)) / 100
        inner = (f'<img src="{s["watermark_image"]}" alt="" style="max-width:60%;opacity:{op}">' if s.get("watermark_image")
                 else f'<span style="opacity:{op}">{escape(s["watermark_text"] or "")}</span>')
        wm = f'<div class="wm">{inner}</div>'

    css = f"""
:root{{--a:{escape(accent)};--ink:#111827;--mut:#6b7280;--line:#d7e3e1;--tint:#e8f3f1}}
*{{box-sizing:border-box}} body{{margin:0;background:#eef2f6;font:10pt/1.45 'Poppins',Arial,sans-serif;color:var(--ink)}}
.page{{position:relative;max-width:760px;margin:20px auto;background:#fff;padding:34px 38px;border-top:8px solid var(--a);overflow:hidden}}
.name{{font-weight:700;font-size:15pt}} .sub{{font-size:8.5pt;color:var(--mut)}} .logo{{max-height:46px;max-width:140px;margin-right:12px}}
.co{{display:flex;align-items:center}} .head{{display:flex;justify-content:space-between;align-items:flex-start}} .hr{{text-align:right}}
.tag{{font-size:8pt;letter-spacing:.2em;font-weight:700;color:var(--a)}} .per{{display:block;font-size:12.5pt;margin-top:4px}}
.rule{{border-top:2px solid var(--a);margin:14px 0}} .banner{{background:var(--tint);color:var(--a);text-align:center;font-weight:700;letter-spacing:.14em;font-size:9pt;padding:6px;margin-bottom:10px}}
.grid{{display:grid;border:2px solid var(--a);margin:8px 0}} .g2{{grid-template-columns:1fr 1.4fr 1fr 1.4fr}} .g3{{grid-template-columns:repeat(6,auto)}} .g1{{grid-template-columns:1fr 1.6fr}}
.grid .k{{background:var(--tint);padding:9px 8px;font-size:8pt;color:var(--mut);border:1px solid #dbe7e5}} .grid .v{{padding:9px 8px;font-weight:600;border:1px solid #dbe7e5}}
.k{{font-size:8pt;color:var(--mut)}} .att{{width:100%;border-collapse:collapse;margin:10px 0;text-align:center}} .att th{{font-size:7.5pt;color:var(--mut);font-weight:500;border:1px solid var(--line);padding:5px}} .att td{{font-weight:700;color:var(--a);padding:5px;border:1px solid var(--line)}}
.cols{{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:12px 0}} .ed{{width:100%;border-collapse:collapse;font-size:9.5pt}} .ed th{{background:var(--tint);color:var(--a);text-align:left;padding:6px 8px;font-size:8pt;letter-spacing:.06em;text-transform:uppercase}} .ed td{{padding:5px 8px;border-bottom:1px solid #eef2f1}}
.num{{text-align:right!important;font-variant-numeric:tabular-nums;white-space:nowrap}} .tot td{{font-weight:700;background:var(--tint)}}
.netbar{{display:flex;justify-content:space-between;align-items:center;background:var(--a);color:#fff;padding:12px 16px;margin-top:8px;font-size:10pt;letter-spacing:.08em}} .netbar b{{font-size:15pt}}
.words{{border:1px solid var(--line);padding:6px 10px;margin-top:8px;font-size:9pt}}
.sign{{display:flex;justify-content:space-between;margin-top:42px;font-size:8.5pt;text-align:center}} .sign .line{{border-top:1px solid #999;width:170px;margin:0 auto 4px}} .sigimg{{max-height:38px;display:block;margin:0 auto -6px}}
.foot{{margin-top:22px;text-align:center;font-size:7.5pt;color:var(--mut);font-style:italic}} .note{{margin-top:8px;font-size:8.5pt;color:var(--mut)}}
.band{{background:var(--a);color:#fff;margin:-34px -38px 22px;padding:26px 38px;display:flex;justify-content:space-between;align-items:flex-start}} .band .sub{{color:#cfe8e4}} .band .tag{{color:#fff}} .bandr{{text-align:right}}
.cards{{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}} .card{{border:1px solid var(--line);border-radius:10px;padding:10px}} .card .v{{font-weight:700;margin-top:6px}}
.netpanel{{border:2px solid #7cc4bb;background:#eef8f6;border-radius:14px;padding:18px 22px;margin:14px 0}} .big{{font-size:22pt;font-weight:700;color:var(--a);margin:10px 0}} .row{{display:flex;justify-content:space-between;gap:12px;font-size:8.5pt;margin-top:6px}}
.split{{display:grid;grid-template-columns:1.6fr 1fr;gap:18px;margin-top:14px}} .panel{{border:2px solid #7cc4bb;background:#eef8f6;border-radius:16px;padding:18px}} .panel .big{{font-size:17pt}}
.exco{{letter-spacing:.3em;font-weight:700;font-size:10pt}} .exrule{{border-top:2px solid var(--ink);margin:12px 0 22px}} .exrow{{display:flex;justify-content:space-between}} .exname{{font-size:22pt;font-weight:600;margin-top:34px}} .exnet{{font-size:30pt;font-weight:700;color:var(--a)}} .exc .ed td{{padding:9px 8px;border:0}}
.wm{{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:64pt;font-weight:800;color:#000;transform:rotate(-24deg);pointer-events:none}}
@media print{{body{{background:#fff}} .page{{margin:0;max-width:none}}}}
"""
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Payslip — {escape(emp['name'])} · {escape(d['period'])}</title>
<style>{css}</style></head><body><div class="page">{wm}{body}</div></body></html>"""
