/* My Customers — everyone who bought, from conversion to renewal.
 *
 * The list is a renewal list first and a directory second, because that is the
 * question people actually open it with: who is about to lapse. So the tiles
 * count renewal windows rather than restating the row count, and the table's
 * loudest column is the renewal date.
 *
 * A customer's plans live in the drawer rather than on a page of their own.
 * They are only ever read *about* a customer — nobody asks "show me all the
 * plans" — and a separate route would mean losing the list you were working
 * through to add one line.
 */

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import '../../styles/crm.css'
import { useQuery } from '../../lib/useQuery'
import { dateTime, shortDate } from '../../lib/format'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconPlus,
  IconSearch,
  IconUsers,
} from '../../components/Icons'
import {
  crm,
  crmError,
  inDays,
  rupees,
  todayISO,
  type Customer,
  type CustomerDetail,
  type CustomerPlan,
} from './api'
import {
  CrmPage,
  Dialog,
  Drawer,
  Field,
  MasterSelect,
  OwnerSelect,
  Stat,
  StateText,
  Stats,
  WhatsAppButton,
} from './parts'

export default function MyCustomers() {
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [renewal, setRenewal] = useState('')
  const [managerId, setManagerId] = useState('')
  const [adding, setAdding] = useState(false)
  const [openId, setOpenId] = useState<string | null>(params.get('open'))
  const [rowError] = useState<string | null>(null)

  const rows = useQuery<Customer[]>(
    `crm-customers-${q}-${status}-${renewal}-${managerId}`,
    () =>
      crm.customers({
        q: q.trim() || undefined,
        status: status || undefined,
        renewal: renewal || undefined,
        manager_id: managerId || undefined,
      }),
  )

  // Counters read the unfiltered list, so switching the "renewal due" filter on
  // does not change the number the filter is counting.
  const all = useQuery<Customer[]>('crm-customers-all', () => crm.customers({}))
  const list = rows.data ?? []
  const everyone = all.data ?? []
  const dueSoon = everyone.filter(
    (row) =>
      row.primary_plan?.days_to_renewal !== null &&
      row.primary_plan?.days_to_renewal !== undefined &&
      row.primary_plan.days_to_renewal >= 0 &&
      row.primary_plan.days_to_renewal <= 30,
  ).length
  const expired = everyone.filter(
    (row) =>
      row.primary_plan?.days_to_renewal !== null &&
      row.primary_plan?.days_to_renewal !== undefined &&
      row.primary_plan.days_to_renewal < 0,
  ).length

  if (rows.error && !rows.data) {
    return (
      <CrmPage title="My Customers">
        <ErrorNote>{crmError(rows.cause, 'Could not load your customers')}</ErrorNote>
      </CrmPage>
    )
  }

  return (
    <CrmPage
      title="My Customers"
      subtitle="Everyone who bought — from conversion to renewal"
      actions={
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <IconPlus size={15} /> Add Customer
        </button>
      }
    >
      <Stats>
        <Stat label="Customers" value={everyone.length} icon={<IconUsers size={16} />} />
        <Stat
          label="Active"
          value={everyone.filter((row) => row.status === 'active').length}
          icon={<IconCheck size={16} />}
          tone="var(--status-good)"
          toned
        />
        <Stat
          label="Renewal due"
          value={dueSoon}
          meta={dueSoon ? 'within 30 days' : 'nothing lapsing'}
          icon={<IconClock size={16} />}
          tone="var(--status-warn)"
          toned={dueSoon > 0}
        />
        <Stat
          label="Expired"
          value={expired}
          meta={expired ? 'renewal date passed' : undefined}
          icon={<IconAlert size={16} />}
          tone="var(--status-critical)"
          toned={expired > 0}
        />
        <Stat
          label="On hold"
          value={everyone.filter((row) => row.status === 'on_hold').length}
          icon={<IconClock size={16} />}
        />
      </Stats>

      <div className="crm-bar">
        <div className="crm-search">
          <IconSearch size={15} />
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search ID, name, company, mobile, email…"
            aria-label="Search customers"
          />
        </div>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="on_hold">On hold</option>
          <option value="expired">Expired</option>
          <option value="churned">Churned</option>
        </select>
        <select value={renewal} onChange={(event) => setRenewal(event.target.value)} aria-label="Renewal">
          <option value="">All time</option>
          <option value="due">Renewal due</option>
          <option value="expired">Renewal passed</option>
        </select>
        <OwnerSelect value={managerId} onChange={setManagerId} placeholder="Any manager" />
        {(q || status || renewal || managerId) && (
          <button
            className="filter-reset"
            onClick={() => {
              setQ('')
              setStatus('')
              setRenewal('')
              setManagerId('')
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {rowError && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{rowError}</ErrorNote>
        </div>
      )}

      <section className="card" style={{ opacity: rows.refetching ? 0.6 : 1 }}>
        {list.length === 0 ? (
          rows.loading ? (
            <Loading />
          ) : (
            <EmptyState
              icon={<IconUsers size={22} />}
              title="No customers yet"
              body="Convert a lead once they buy, or add an existing account by hand. Everything else in the CRM — visits, support calls, renewals — hangs off a customer record."
              action={
                <button className="btn btn-primary" onClick={() => setAdding(true)}>
                  Add the first customer
                </button>
              }
            />
          )
        ) : (
          <>
            <div className="table-wrap">
              <table className="crm-table-wide">
                <thead>
                  <tr>
                    <th>Customer ID</th>
                    <th>Customer</th>
                    <th>Mobile</th>
                    <th>Product / Plan</th>
                    <th>Plan period</th>
                    <th>Renewal</th>
                    <th>Manager</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((row) => (
                    <tr key={row.id}>
                      <td className="crm-code">{row.code}</td>
                      <td>
                        <button className="link-btn" onClick={() => setOpenId(row.id)}>
                          <div className="crm-strong">{row.name}</div>
                          {row.company && <div className="crm-sub">{row.company}</div>}
                        </button>
                      </td>
                      <td className="crm-nowrap">
                        <WhatsAppButton mobile={row.whatsapp ?? row.mobile} />
                        {row.mobile}
                      </td>
                      <td>
                        {row.primary_plan ? (
                          <>
                            <span className="crm-pill">{row.primary_plan.product_name}</span>
                            {row.primary_plan.plan_name && (
                              <div className="crm-sub">{row.primary_plan.plan_name}</div>
                            )}
                            {row.plan_count > 1 && (
                              <div className="crm-sub">+{row.plan_count - 1} more</div>
                            )}
                          </>
                        ) : (
                          <span className="crm-muted">Nothing recorded</span>
                        )}
                      </td>
                      <td className="crm-nowrap crm-sub">
                        {row.primary_plan
                          ? `${row.primary_plan.start_on} → ${row.primary_plan.end_on ?? 'perpetual'}`
                          : '—'}
                      </td>
                      <td className="crm-nowrap">
                        {row.primary_plan?.renewal_on ?? <span className="crm-muted">—</span>}
                        {row.primary_plan?.days_to_renewal !== null &&
                          row.primary_plan?.days_to_renewal !== undefined && (
                            <div
                              className={
                                row.primary_plan.days_to_renewal < 0
                                  ? 'crm-due-over'
                                  : row.primary_plan.days_to_renewal <= 30
                                    ? 'crm-due-today'
                                    : 'crm-sub'
                              }
                            >
                              {inDays(row.primary_plan.days_to_renewal)}
                            </div>
                          )}
                      </td>
                      <td>{row.manager_name ?? <span className="crm-muted">—</span>}</td>
                      <td>
                        <StateText value={row.status} />
                      </td>
                      <td>
                        <div className="crm-row-actions">
                          <button className="link-btn" onClick={() => setOpenId(row.id)}>
                            Open
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="crm-foot">
              <span>
                {list.length} of {everyone.length} customer{everyone.length === 1 ? '' : 's'}
              </span>
            </div>
          </>
        )}
      </section>

      {adding && (
        <CustomerForm
          onClose={() => setAdding(false)}
          onSaved={(created) => {
            setAdding(false)
            rows.reload()
            all.reload()
            // Straight into the record, because the next thing anybody does
            // after creating a customer is say what they bought.
            setOpenId(created.id)
          }}
        />
      )}

      {openId && (
        <CustomerDrawer
          customerId={openId}
          onClose={() => {
            setOpenId(null)
            if (params.get('open')) setParams({}, { replace: true })
          }}
          onChanged={() => {
            rows.reload()
            all.reload()
          }}
        />
      )}
    </CrmPage>
  )
}

/* ------------------------------------------------------------------- form --- */

function CustomerForm({
  customer,
  onClose,
  onSaved,
}: {
  customer?: Customer
  onClose: () => void
  onSaved: (row: Customer) => void
}) {
  const [code, setCode] = useState(customer?.code ?? '')
  const [name, setName] = useState(customer?.name ?? '')
  const [company, setCompany] = useState(customer?.company ?? '')
  const [mobile, setMobile] = useState(customer?.mobile ?? '')
  const [sameNumber, setSameNumber] = useState(
    customer ? (customer.whatsapp ?? customer.mobile) === customer.mobile : true,
  )
  const [whatsapp, setWhatsapp] = useState(customer?.whatsapp ?? '')
  const [email, setEmail] = useState(customer?.email ?? '')
  const [type, setType] = useState(customer?.customer_type ?? '')
  const [industryId, setIndustryId] = useState(customer?.industry_id ?? '')
  const [sourceId, setSourceId] = useState(customer?.source_id ?? '')
  const [gstin, setGstin] = useState(customer?.gstin ?? '')
  const [countryId, setCountryId] = useState(customer?.country_id ?? '')
  const [stateId, setStateId] = useState(customer?.state_id ?? '')
  const [cityId, setCityId] = useState(customer?.city_id ?? '')
  const [pincode, setPincode] = useState(customer?.pincode ?? '')
  const [address, setAddress] = useState(customer?.address ?? '')
  const [managerId, setManagerId] = useState(customer?.manager_id ?? '')
  const [status, setStatus] = useState(customer?.status ?? 'active')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const countries = useQuery('crm-countries', () => crm.masters('countries'))
  useEffect(() => {
    if (!countryId && countries.data?.length) setCountryId(countries.data[0].id)
  }, [countries.data, countryId])

  async function save() {
    setBusy(true)
    setError(null)
    const body = {
      code: code || null,
      name,
      company: company || null,
      mobile,
      whatsapp: sameNumber ? mobile : whatsapp || null,
      email: email || null,
      customer_type: type || null,
      industry_id: industryId || null,
      source_id: sourceId || null,
      gstin: gstin || null,
      country_id: countryId || null,
      state_id: stateId || null,
      city_id: cityId || null,
      pincode: pincode || null,
      address: address || null,
      manager_id: managerId || null,
      status,
    }
    try {
      const saved = customer
        ? await crm.patchCustomer(customer.id, body)
        : await crm.createCustomer(body)
      onSaved(saved)
    } catch (err) {
      setError(crmError(err, 'That customer could not be saved'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={customer ? `Edit ${customer.name}` : 'Add Customer'}
      subtitle="Products and services are added on the customer's own record, which opens next."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !name.trim() || !mobile.trim()}
          >
            {busy ? 'Saving…' : 'Save Customer'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && (
          <div className="crm-form-wide">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        <Field label="Customer ID" hint="Your own reference — generated when left blank.">
          <input value={code} onChange={(event) => setCode(event.target.value)} disabled={Boolean(customer)} />
        </Field>
        <Field label="Customer name *">
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus required />
        </Field>

        <Field label="Company name">
          <input value={company} onChange={(event) => setCompany(event.target.value)} />
        </Field>
        <Field label="Mobile number *">
          <input value={mobile} onChange={(event) => setMobile(event.target.value)} required />
        </Field>

        <div className="crm-field">
          <span className="crm-field-label">WhatsApp number</span>
          <input
            value={sameNumber ? '' : whatsapp}
            onChange={(event) => setWhatsapp(event.target.value)}
            placeholder="Same as mobile"
            disabled={sameNumber}
          />
          <label className="crm-check">
            <input
              type="checkbox"
              checked={sameNumber}
              onChange={(event) => setSameNumber(event.target.checked)}
            />
            Same number for WhatsApp
          </label>
        </div>
        <Field label="Email">
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>

        <Field label="Customer type">
          <input
            value={type}
            onChange={(event) => setType(event.target.value)}
            placeholder="Not set"
            list="crm-customer-types"
          />
          <datalist id="crm-customer-types">
            <option value="Enterprise" />
            <option value="SMB" />
            <option value="Individual" />
            <option value="Reseller" />
          </datalist>
        </Field>
        <Field label="Industry">
          <MasterSelect kind="industries" value={industryId} onChange={setIndustryId} placeholder="Not set" />
        </Field>

        <Field label="Lead source">
          <MasterSelect kind="sources" value={sourceId} onChange={setSourceId} placeholder="Not set" />
        </Field>
        <Field label="GSTIN" hint="Decides the tax treatment on their quotations.">
          <input
            value={gstin}
            onChange={(event) => setGstin(event.target.value.toUpperCase())}
            placeholder="27AAAAA0000A1Z5"
          />
        </Field>

        <Field label="Country">
          <MasterSelect
            kind="countries"
            value={countryId}
            onChange={(next) => {
              setCountryId(next)
              setStateId('')
              setCityId('')
            }}
          />
        </Field>
        <Field label="State">
          <MasterSelect
            kind="states"
            value={stateId}
            onChange={(next) => {
              setStateId(next)
              setCityId('')
            }}
            parentId={countryId}
            placeholder="Not set"
          />
        </Field>

        <Field label="City">
          <MasterSelect kind="cities" value={cityId} onChange={setCityId} parentId={stateId} placeholder="Not set" />
        </Field>
        <Field label="Pincode">
          <input value={pincode} onChange={(event) => setPincode(event.target.value)} />
        </Field>

        <Field label="Account manager">
          <OwnerSelect value={managerId} onChange={setManagerId} placeholder="You" />
        </Field>
        <Field label="Status">
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="active">Active</option>
            <option value="on_hold">On hold</option>
            <option value="expired">Expired</option>
            <option value="churned">Churned</option>
          </select>
        </Field>

        <Field label="Address" wide>
          <textarea value={address} onChange={(event) => setAddress(event.target.value)} rows={3} />
        </Field>
      </div>
    </Dialog>
  )
}

/* ----------------------------------------------------------------- drawer --- */

function CustomerDrawer({
  customerId,
  onClose,
  onChanged,
}: {
  customerId: string
  onClose: () => void
  onChanged: () => void
}) {
  const detail = useQuery<CustomerDetail>(`crm-customer-${customerId}`, () =>
    crm.customer(customerId),
  )
  const [editing, setEditing] = useState(false)
  const [planEditing, setPlanEditing] = useState<CustomerPlan | null>(null)
  const [addingPlan, setAddingPlan] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const customer = detail.data

  async function removePlan(plan: CustomerPlan) {
    setError(null)
    try {
      await crm.deletePlan(plan.id)
      detail.reload()
      onChanged()
    } catch (err) {
      setError(crmError(err, 'That plan could not be removed'))
    }
  }

  return (
    <Drawer
      title={customer?.name ?? 'Customer'}
      meta={customer ? `${customer.code} · ${customer.mobile}` : undefined}
      onClose={onClose}
      footer={
        customer && (
          <>
            <button className="btn btn-sm" onClick={() => setEditing(true)}>
              Edit details
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => setAddingPlan(true)}>
              Add a plan
            </button>
            <WhatsAppButton mobile={customer.whatsapp ?? customer.mobile} />
          </>
        )
      }
    >
      {!customer ? (
        <Loading />
      ) : (
        <>
          {error && <ErrorNote>{error}</ErrorNote>}

          <div className="crm-facts" style={{ padding: 0 }}>
            <div>
              <div className="crm-fact-label">Status</div>
              <div className="crm-fact-value">
                <StateText value={customer.status} />
              </div>
            </div>
            <div>
              <div className="crm-fact-label">Account manager</div>
              <div className="crm-fact-value">{customer.manager_name ?? '—'}</div>
            </div>
            <div>
              <div className="crm-fact-label">GSTIN</div>
              <div className="crm-fact-value">{customer.gstin ?? '—'}</div>
            </div>
            <div>
              <div className="crm-fact-label">Since</div>
              <div className="crm-fact-value">{shortDate(customer.created_at)}</div>
            </div>
          </div>

          {customer.converted_from_lead_id && (
            <div className="notice notice-ok">This account started as a lead.</div>
          )}

          <div>
            <div className="crm-field-label" style={{ marginBottom: 6 }}>
              Products &amp; plans
            </div>
            {customer.plans.length === 0 ? (
              <p className="empty">Nothing recorded. Add what they bought so renewals can be tracked.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Period</th>
                      <th className="crm-num">Amount</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {customer.plans.map((plan) => (
                      <tr key={plan.id}>
                        <td>
                          <div className="crm-strong">{plan.product_name}</div>
                          <div className="crm-sub">{plan.plan_name ?? '—'}</div>
                        </td>
                        <td className="crm-sub">
                          {plan.start_on} → {plan.end_on ?? 'perpetual'}
                          <div className={plan.days_to_renewal !== null && plan.days_to_renewal < 0 ? 'crm-due-over' : ''}>
                            renews {inDays(plan.days_to_renewal)}
                          </div>
                        </td>
                        <td className="crm-num">
                          {rupees(plan.amount)}
                          <div className="crm-sub">
                            <StateText value={plan.payment_status} />
                          </div>
                        </td>
                        <td>
                          <div className="crm-row-actions">
                            <button className="link-btn" onClick={() => setPlanEditing(plan)}>
                              Edit
                            </button>
                            <button className="link-btn" onClick={() => removePlan(plan)}>
                              Remove
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {customer.interactions.length > 0 && (
            <div>
              <div className="crm-field-label" style={{ marginBottom: 6 }}>
                Recent calls
              </div>
              <div className="crm-timeline">
                {customer.interactions.slice(0, 8).map((row) => (
                  <div className="crm-event" key={row.id}>
                    <span className="crm-event-dot" />
                    <div>
                      <div className="crm-event-body">
                        {row.disposition_name ?? 'Call'} — {row.remarks ?? 'no remarks'}
                      </div>
                      <div className="crm-event-when">
                        {row.direction} · {row.staff_name ?? 'unknown'} · {dateTime(row.created_at)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {editing && (
            <CustomerForm
              customer={customer}
              onClose={() => setEditing(false)}
              onSaved={() => {
                setEditing(false)
                detail.reload()
                onChanged()
              }}
            />
          )}

          {(addingPlan || planEditing) && (
            <PlanForm
              customerId={customer.id}
              plan={planEditing}
              onClose={() => {
                setAddingPlan(false)
                setPlanEditing(null)
              }}
              onSaved={() => {
                setAddingPlan(false)
                setPlanEditing(null)
                detail.reload()
                onChanged()
              }}
            />
          )}
        </>
      )}
    </Drawer>
  )
}

function PlanForm({
  customerId,
  plan,
  onClose,
  onSaved,
}: {
  customerId: string
  plan: CustomerPlan | null
  onClose: () => void
  onSaved: () => void
}) {
  const [productId, setProductId] = useState(plan?.product_id ?? '')
  const [planId, setPlanId] = useState(plan?.plan_id ?? '')
  const [productName, setProductName] = useState(plan?.product_name ?? '')
  const [startOn, setStartOn] = useState(plan?.start_on ?? todayISO())
  const [endOn, setEndOn] = useState(plan?.end_on ?? '')
  const [renewalOn, setRenewalOn] = useState(plan?.renewal_on ?? '')
  const [amount, setAmount] = useState(plan?.amount ?? '')
  const [payment, setPayment] = useState(plan?.payment_status ?? 'pending')
  const [status, setStatus] = useState(plan?.status ?? 'active')
  const [notes, setNotes] = useState(plan?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    const body = {
      product_id: productId || null,
      plan_id: planId || null,
      // Free text is allowed so a sale can be recorded for something the
      // catalogue has not caught up with — the sale happened either way.
      product_name: productName || null,
      start_on: startOn,
      end_on: endOn || null,
      renewal_on: renewalOn || null,
      amount: amount || '0',
      payment_status: payment,
      status,
      notes: notes || null,
    }
    try {
      if (plan) await crm.updatePlan(plan.id, body)
      else await crm.addPlan(customerId, body)
      onSaved()
    } catch (err) {
      setError(crmError(err, 'That plan could not be saved'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={plan ? 'Edit plan' : 'Add a plan'}
      subtitle="Leave the end date blank and it is worked out from the plan's own duration."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save plan'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && (
          <div className="crm-form-wide">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        <Field label="Product / Service">
          <MasterSelect
            kind="products"
            value={productId}
            onChange={(next) => {
              setProductId(next)
              setPlanId('')
            }}
          />
        </Field>
        <Field label="Plan">
          <MasterSelect kind="plans" value={planId} onChange={setPlanId} parentId={productId} />
        </Field>

        <Field
          label="Or type what they bought"
          wide
          hint="Used when it is not on the catalogue yet."
        >
          <input
            value={productName}
            onChange={(event) => setProductName(event.target.value)}
            placeholder="Product name as it should read"
          />
        </Field>

        <Field label="Starts on">
          <input type="date" value={startOn} onChange={(event) => setStartOn(event.target.value)} />
        </Field>
        <Field label="Ends on">
          <input type="date" value={endOn} onChange={(event) => setEndOn(event.target.value)} />
        </Field>

        <Field label="Renewal date" hint="Defaults to the end date.">
          <input type="date" value={renewalOn} onChange={(event) => setRenewalOn(event.target.value)} />
        </Field>
        <Field label="Amount">
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            placeholder="0.00"
          />
        </Field>

        <Field label="Payment">
          <select value={payment} onChange={(event) => setPayment(event.target.value as typeof payment)}>
            <option value="pending">Pending</option>
            <option value="partial">Partial</option>
            <option value="paid">Paid</option>
          </select>
        </Field>
        <Field label="Status">
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </Field>

        <Field label="Notes" wide>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
        </Field>
      </div>
    </Dialog>
  )
}
