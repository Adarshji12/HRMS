/* ERP data layer — the shapes `app/services/erp` returns, and one call per route.

   Money and quantity arrive as decimal strings ("10620.00", "6.000"), exactly
   like the CRM's. Display them with `rupees()` and `qtyText()`; never add two of
   them as floats on the client — the server already sent the total. */

import { api } from '../../lib/api'

export { crmError as erpError, rupees, rupeesShort } from '../crm/api'

/* ------------------------------------------------------------------ types --- */

export type Capability =
  | 'can_manage_erp_masters'
  | 'can_verify_vendors'
  | 'can_manage_procurement'
  | 'can_approve_purchases'
  | 'can_manage_inventory'
  | 'can_approve_stock'
  | 'can_manage_sales_orders'
  | 'can_approve_sales_orders'
  | 'can_manage_billing'
  | 'can_approve_billing'

export type Access = Record<Capability, boolean>

export interface ChainStep {
  id: string
  level: number
  status: 'pending' | 'approved' | 'rejected' | 'skipped' | 'escalated'
  reviewer_rule: string
  reviewer_user_id: string | null
  reviewer_name?: string | null
  acted_by_name?: string | null
  acted_at: string | null
  note: string | null
}

export interface Warehouse {
  id: string
  code: string
  name: string
  kind: 'warehouse' | 'hub' | 'branch' | 'site' | 'engineer'
  address: string | null
  state: string | null
  custodian_id: string | null
  custodian_name: string | null
  is_active: boolean
}

export interface Item {
  id: string
  code: string
  name: string
  description: string | null
  item_type: 'goods' | 'service'
  category: string | null
  uom: string
  hsn_sac: string | null
  gst_percent: string
  make: string | null
  model: string | null
  part_number: string | null
  is_serialized: boolean
  warranty_months: number
  standard_cost: string
  sale_price: string
  reorder_level: string
  min_level: string
  max_level: string
  crm_product_id: string | null
  is_active: boolean
  available_qty: string
  below_reorder: boolean
}

export interface VendorBank {
  id: string
  account_name: string
  account_number: string
  ifsc: string
  bank_name: string | null
  status: 'pending' | 'verified' | 'rejected' | 'superseded'
  created_by_name: string | null
  verified_by_name: string | null
  note: string | null
}

export interface Vendor {
  id: string
  code: string
  legal_name: string
  vendor_type: string
  category: string | null
  gstin: string | null
  pan: string | null
  contact_name: string | null
  email: string | null
  phone: string | null
  address: string | null
  state: string | null
  payment_terms_days: number
  advance_allowed: boolean
  is_msme: boolean
  msme_number: string | null
  agreement_expiry: string | null
  agreement_expired: boolean
  status: 'draft' | 'pending' | 'active' | 'suspended' | 'blacklisted'
  status_reason: string | null
  created_by: string | null
  created_by_name: string | null
  approved_by_name: string | null
  performance_score: string | null
  banks: VendorBank[]
}

export interface CustomerSite {
  id: string
  name: string
  address: string | null
  state: string | null
  contact_name: string | null
  contact_phone: string | null
  is_active: boolean
}

export interface CustomerAccount {
  customer_id: string
  customer_code: string
  customer_name: string
  contact_name: string
  mobile: string
  email: string | null
  crm_gstin: string | null
  account: null | {
    id: string
    legal_name: string | null
    gstin: string | null
    pan: string | null
    billing_address: string | null
    billing_state: string | null
    shipping_address: string | null
    credit_limit: string
    credit_days: number
    credit_hold: boolean
    hold_reason: string | null
    sites: CustomerSite[]
  }
  outstanding: string
  overdue: string
  oldest_overdue_days: number
  open_order_value: string
}

export interface DocLine {
  id: string
  item_id: string | null
  item_code?: string | null
  description: string
  uom?: string
  quantity: string
  rate?: string
  gst_percent?: string
  taxable_value?: string
  tax_amount?: string
  amount?: string
  is_serialized?: boolean
  is_stocked?: boolean
}

export interface Requisition {
  id: string
  number: string
  title: string
  purpose: string | null
  requested_by: string
  requested_by_name: string | null
  required_by: string | null
  warehouse_id: string | null
  project_id: string | null
  sales_order_id: string | null
  status: string
  estimated_total: string
  submitted_at: string | null
  reviewed_by_name: string | null
  review_note: string | null
  cancel_reason: string | null
  created_at: string
  chain: ChainStep[]
  lines: (DocLine & { estimated_rate: string; ordered_qty: string; remaining_qty: string })[]
}

export interface VendorQuote {
  id: string
  vendor_id: string
  vendor_name: string | null
  round: number
  quote_ref: string | null
  valid_until: string | null
  delivery_days: number | null
  payment_terms: string | null
  freight: string
  taxable_total: string
  tax_total: string
  landed_total: string
  is_selected: boolean
  lines: { rfq_line_id: string; rate: string; gst_percent: string }[]
}

export interface Rfq {
  id: string
  number: string
  title: string
  requisition_id: string | null
  due_date: string | null
  status: 'draft' | 'issued' | 'awarded' | 'cancelled'
  award_reason: string | null
  created_at: string
  lines: DocLine[]
  vendors: { vendor_id: string; legal_name: string; code: string; quoted: boolean }[]
  quotes: VendorQuote[]
}

export interface Comparison {
  rfq: Rfq
  quotes: (VendorQuote & { rank: number; is_lowest: boolean; vendor_score: string | null })[]
  lines: (DocLine & { rates: Record<string, { rate: string; gst_percent: string; amount: string }>; lowest_rate: string | null })[]
}

export interface PurchaseOrder {
  id: string
  number: string
  revision: number
  vendor_id: string
  vendor_name: string | null
  vendor_code: string | null
  requisition_id: string | null
  rfq_id: string | null
  sales_order_id: string | null
  project_id: string | null
  warehouse_id: string | null
  warehouse_name: string | null
  order_date: string
  expected_date: string | null
  committed_date: string | null
  payment_terms: string | null
  delivery_terms: string | null
  ld_percent_per_week: string
  ld_cap_percent: string
  ld_amount: string
  ld_waived: boolean
  ld_waiver_reason: string | null
  sub_total: string
  tax_total: string
  freight: string
  grand_total: string
  terms: string | null
  notes: string | null
  status: string
  created_by: string
  created_by_name: string | null
  reviewed_by_name: string | null
  review_note: string | null
  closed_reason: string | null
  is_overdue: boolean
  chain: ChainStep[]
  lines: (DocLine & { received_qty: string; pending_qty: string; hsn_sac: string | null })[]
  receipts: { id: string; number: string; received_on: string; status: string; days_late: number; ld_amount: string }[]
}

export interface GoodsReceipt {
  id: string
  number: string
  purchase_order_id: string
  po_number: string | null
  vendor_name: string | null
  warehouse_name: string | null
  received_on: string
  challan_ref: string | null
  invoice_ref: string | null
  status: 'posted' | 'reversed'
  days_late: number
  ld_amount: string
  received_by_name: string | null
  reverse_reason: string | null
  lines: {
    id: string
    description: string
    received_qty: string
    accepted_qty: string
    rejected_qty: string
    condition: string
    unit_cost: string
    serials: string[] | null
  }[]
}

export interface StockBalance {
  id: string
  item_id: string
  item_code: string
  item_name: string
  uom: string
  is_serialized: boolean
  warehouse_id: string
  warehouse_name: string
  condition: string
  quantity: string
  reserved_qty: string
  available_qty: string
  avg_cost: string
  value: string
  reorder_level: string
}

export interface Movement {
  id: string
  item_code: string
  item_name: string
  uom: string
  warehouse_name: string
  condition: string
  kind: string
  quantity: string
  unit_cost: string
  value: string
  balance_after: string
  ref_type: string
  ref_number: string | null
  serials: string[] | null
  reason: string | null
  created_at: string
  created_by_name: string | null
}

export interface SerialRow {
  id: string
  serial_no: string
  item_code: string
  item_name: string
  status: string
  condition: string
  warehouse_name: string | null
  warranty_until: string | null
  customer_id: string | null
  history: { id: string; kind: string; ref_number: string | null; warehouse_name: string | null; condition: string | null; created_at: string }[]
}

export interface StockDoc {
  id: string
  number: string
  kind: 'issue' | 'return' | 'transfer' | 'adjustment'
  from_warehouse_id: string | null
  from_warehouse_name: string | null
  to_warehouse_id: string | null
  to_warehouse_name: string | null
  doc_date: string
  reason: string | null
  notes: string | null
  status: string
  value: string
  created_by: string
  created_by_name: string | null
  reviewed_by_name: string | null
  review_note: string | null
  recipient_name: string | null
  chain: ChainStep[]
  lines: { id: string; item_id: string; item_code: string | null; item_name: string | null; uom: string | null; quantity: string; condition: string; unit_cost: string; serials: string[] | null; is_serialized: boolean }[]
}

export interface Milestone {
  id: string
  name: string
  kind: string
  taxable_amount: string
  gst_percent: string
  due_date: string | null
  status: 'pending' | 'ready' | 'invoiced'
  evidence: string | null
  invoice_id: string | null
}

export interface SalesOrder {
  id: string
  number: string
  customer_id: string
  customer_name: string
  quotation_id: string | null
  quotation_number: string | null
  site_id: string | null
  site_name: string | null
  customer_po_number: string | null
  customer_po_date: string | null
  customer_po_value: string | null
  order_date: string
  required_by: string | null
  billing_address: string | null
  shipping_address: string | null
  place_of_supply: string | null
  payment_terms: string | null
  is_interstate: boolean
  sub_total: string
  tax_total: string
  grand_total: string
  quoted_total: string | null
  has_deviation: boolean
  deviation_note: string | null
  hold_reason: string | null
  notes: string | null
  status: string
  created_by: string
  created_by_name: string | null
  reviewed_by_name: string | null
  review_note: string | null
  closed_reason: string | null
  invoiced_total: string
  chain: ChainStep[]
  lines: (DocLine & {
    fulfilment: 'stock' | 'procure' | 'service'
    reserved_qty: string
    reserved_warehouse_id: string | null
    dispatched_qty: string
    invoiced_qty: string
    pending_qty: string
    available_qty: string | null
  })[]
  milestones: Milestone[]
  dispatches: { id: string; number: string; dispatch_date: string; status: string; value: string }[]
  invoices: { id: string; number: string | null; kind: string; status: string; grand_total: string; invoice_date: string }[]
}

export interface Dispatch {
  id: string
  number: string
  sales_order_id: string
  order_number: string | null
  customer_name: string | null
  customer_id: string | null
  warehouse_name: string | null
  dispatch_date: string
  transporter: string | null
  tracking_ref: string | null
  vehicle_no: string | null
  eway_bill_no: string | null
  ship_to: string | null
  status: 'dispatched' | 'delivered' | 'cancelled'
  delivered_on: string | null
  pod_received_by: string | null
  value: string
  uninvoiced: boolean
  lines: { id: string; description: string; quantity: string; invoiced_qty: string; serials: string[] | null }[]
}

export interface Invoice {
  id: string
  number: string | null
  kind: 'product' | 'service' | 'milestone' | 'proforma' | 'credit_note'
  customer_id: string
  customer_name: string
  gstin: string | null
  billing_address: string | null
  place_of_supply: string | null
  sales_order_id: string | null
  order_number: string | null
  original_invoice_id: string | null
  original_number: string | null
  invoice_date: string
  due_date: string | null
  is_interstate: boolean
  sub_total: string
  cgst: string
  sgst: string
  igst: string
  tax_total: string
  grand_total: string
  amount_received: string
  amount_credited: string
  outstanding: string
  days_overdue: number
  reason: string | null
  notes: string | null
  status: 'draft' | 'submitted' | 'posted' | 'rejected' | 'cancelled'
  created_by: string
  created_by_name: string | null
  posted_by_name: string | null
  reviewed_by_name: string | null
  review_note: string | null
  cancel_reason: string | null
  chain: ChainStep[]
  lines: DocLine[]
  receipts: { id: string; number: string; received_on: string; amount: string; tds_amount: string; mode: string; reference: string | null; status: string }[]
  credit_notes: { id: string; number: string | null; status: string; grand_total: string }[]
}

export interface Ageing {
  buckets: string[]
  rows: (Record<string, string | number> & { customer_id: string; customer_name: string; total: string; invoices: number })[]
  totals: Record<string, string>
  total: string
}

export interface PendingApproval {
  kind: 'purchase_requisition' | 'purchase_order' | 'stock_adjustment' | 'sales_order' | 'credit_note'
  id: string
  number: string | null
  title: string
  amount: string
  subject_name: string | null
  submitted_at: string | null
  level: string | null
}

export interface Dashboard {
  capabilities: Access
  procurement: Record<string, number | string>
  inventory: Record<string, number | string> & {
    low_stock_items: { id: string; code: string; name: string; available: string; reorder_level: string }[]
  }
  sales: Record<string, number | string>
  billing: Record<string, number | string>
}

export interface ErpSettingsRow {
  grn_over_receipt_pct: string
  allow_negative_stock: boolean
  invoice_maker_checker: boolean
  default_credit_days: number
  block_orders_overdue_days: number
  po_terms: string | null
  invoice_terms: string | null
}

/* ------------------------------------------------------------------ calls --- */

const B = '/erp'

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (!entries.length) return ''
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()
}

type Body = Record<string, unknown>

export const erp = {
  access: () => api.get<Access>(`${B}/access`),
  dashboard: () => api.get<Dashboard>(`${B}/dashboard`),
  approvals: () => api.get<PendingApproval[]>(`${B}/approvals`),
  settings: () => api.get<ErpSettingsRow>(`${B}/settings`),
  saveSettings: (body: ErpSettingsRow) => api.put<ErpSettingsRow>(`${B}/settings`, body),

  warehouses: (activeOnly = false) => api.get<Warehouse[]>(`${B}/warehouses${qs({ active_only: activeOnly || undefined })}`),
  saveWarehouse: (body: Body, id?: string) =>
    id ? api.put<Warehouse>(`${B}/warehouses/${id}`, body) : api.post<Warehouse>(`${B}/warehouses`, body),

  items: (p: { q?: string; active_only?: boolean; item_type?: string } = {}) => api.get<Item[]>(`${B}/items${qs(p)}`),
  saveItem: (body: Body, id?: string) =>
    id ? api.put<Item>(`${B}/items/${id}`, body) : api.post<Item>(`${B}/items`, body),

  vendors: (p: { q?: string; status?: string } = {}) => api.get<Vendor[]>(`${B}/vendors${qs(p)}`),
  saveVendor: (body: Body, id?: string) =>
    id ? api.put<Vendor>(`${B}/vendors/${id}`, body) : api.post<Vendor>(`${B}/vendors`, body),
  submitVendor: (id: string) => api.post<Vendor>(`${B}/vendors/${id}/submit`),
  decideVendor: (id: string, approve: boolean, note?: string) =>
    api.post<Vendor>(`${B}/vendors/${id}/decide`, { approve, note }),
  vendorStatus: (id: string, status: string, reason: string) =>
    api.post<Vendor>(`${B}/vendors/${id}/status`, { status, reason }),
  addBank: (id: string, body: Body) => api.post<Vendor>(`${B}/vendors/${id}/banks`, body),
  verifyBank: (id: string, bankId: string, approve: boolean, note?: string) =>
    api.post<Vendor>(`${B}/vendors/${id}/banks/${bankId}/verify`, { approve, note }),

  customers: (q?: string) => api.get<CustomerAccount[]>(`${B}/customers${qs({ q })}`),
  customer: (id: string) => api.get<CustomerAccount>(`${B}/customers/${id}`),
  saveCustomer: (id: string, body: Body) => api.put<CustomerAccount>(`${B}/customers/${id}`, body),
  customerHold: (id: string, hold: boolean, reason: string) =>
    api.post<CustomerAccount>(`${B}/customers/${id}/hold`, { hold, reason }),
  addSite: (id: string, body: Body) => api.post<CustomerAccount>(`${B}/customers/${id}/sites`, body),

  requisitions: (p: { status?: string; mine?: boolean } = {}) => api.get<Requisition[]>(`${B}/requisitions${qs(p)}`),
  requisition: (id: string) => api.get<Requisition>(`${B}/requisitions/${id}`),
  saveRequisition: (body: Body, id?: string) =>
    id ? api.put<Requisition>(`${B}/requisitions/${id}`, body) : api.post<Requisition>(`${B}/requisitions`, body),
  requisitionAction: (id: string, action: 'submit' | 'revise') => api.post<Requisition>(`${B}/requisitions/${id}/${action}`),
  decideRequisition: (id: string, approve: boolean, note?: string) =>
    api.post<Requisition>(`${B}/requisitions/${id}/decide`, { approve, note }),
  cancelRequisition: (id: string, reason: string) => api.post<Requisition>(`${B}/requisitions/${id}/cancel`, { reason }),
  requisitionToPo: (id: string, vendorId: string) =>
    api.post<PurchaseOrder>(`${B}/requisitions/${id}/purchase-order${qs({ vendor_id: vendorId })}`),

  rfqs: () => api.get<Rfq[]>(`${B}/rfqs`),
  rfq: (id: string) => api.get<Rfq>(`${B}/rfqs/${id}`),
  createRfq: (body: Body) => api.post<Rfq>(`${B}/rfqs`, body),
  issueRfq: (id: string) => api.post<Rfq>(`${B}/rfqs/${id}/issue`),
  addQuote: (id: string, body: Body) => api.post<Rfq>(`${B}/rfqs/${id}/quotes`, body),
  comparison: (id: string) => api.get<Comparison>(`${B}/rfqs/${id}/comparison`),
  award: (id: string, quoteId: string, reason?: string) => api.post<Rfq>(`${B}/rfqs/${id}/award`, { quote_id: quoteId, reason }),
  cancelRfq: (id: string, reason: string) => api.post<Rfq>(`${B}/rfqs/${id}/cancel`, { reason }),
  rfqToPo: (id: string) => api.post<PurchaseOrder>(`${B}/rfqs/${id}/purchase-order`),

  purchaseOrders: (p: { status?: string; q?: string } = {}) => api.get<PurchaseOrder[]>(`${B}/purchase-orders${qs(p)}`),
  purchaseOrder: (id: string) => api.get<PurchaseOrder>(`${B}/purchase-orders/${id}`),
  savePurchaseOrder: (body: Body, id?: string) =>
    id ? api.put<PurchaseOrder>(`${B}/purchase-orders/${id}`, body) : api.post<PurchaseOrder>(`${B}/purchase-orders`, body),
  submitPurchaseOrder: (id: string) => api.post<PurchaseOrder>(`${B}/purchase-orders/${id}/submit`),
  decidePurchaseOrder: (id: string, approve: boolean, note?: string) =>
    api.post<PurchaseOrder>(`${B}/purchase-orders/${id}/decide`, { approve, note }),
  acknowledgePurchaseOrder: (id: string, committed_date?: string) =>
    api.post<PurchaseOrder>(`${B}/purchase-orders/${id}/acknowledge`, { committed_date }),
  purchaseOrderReason: (id: string, action: 'amend' | 'cancel' | 'short-close' | 'waive-ld', reason: string) =>
    api.post<PurchaseOrder>(`${B}/purchase-orders/${id}/${action}`, { reason }),

  goodsReceipts: (poId?: string) => api.get<GoodsReceipt[]>(`${B}/goods-receipts${qs({ po_id: poId })}`),
  postGoodsReceipt: (body: Body) => api.post<GoodsReceipt>(`${B}/goods-receipts`, body),
  reverseGoodsReceipt: (id: string, reason: string) => api.post<GoodsReceipt>(`${B}/goods-receipts/${id}/reverse`, { reason }),

  stock: (p: { item_id?: string; warehouse_id?: string; condition?: string } = {}) =>
    api.get<StockBalance[]>(`${B}/stock${qs(p)}`),
  movements: (p: { item_id?: string; warehouse_id?: string } = {}) => api.get<Movement[]>(`${B}/stock/movements${qs(p)}`),
  serials: (q: string) => api.get<SerialRow[]>(`${B}/stock/serials${qs({ q })}`),
  availableSerials: (itemId: string, warehouseId: string) =>
    api.get<string[]>(`${B}/stock/serials/available${qs({ item_id: itemId, warehouse_id: warehouseId })}`),
  stockDocs: (p: { kind?: string; status?: string } = {}) => api.get<StockDoc[]>(`${B}/stock-docs${qs(p)}`),
  saveStockDoc: (body: Body, id?: string) =>
    id ? api.put<StockDoc>(`${B}/stock-docs/${id}`, body) : api.post<StockDoc>(`${B}/stock-docs`, body),
  stockDocAction: (id: string, action: 'post' | 'receive' | 'submit') => api.post<StockDoc>(`${B}/stock-docs/${id}/${action}`),
  decideStockDoc: (id: string, approve: boolean, note?: string) =>
    api.post<StockDoc>(`${B}/stock-docs/${id}/decide`, { approve, note }),
  cancelStockDoc: (id: string, reason: string) => api.post<StockDoc>(`${B}/stock-docs/${id}/cancel`, { reason }),

  salesOrders: (p: { status?: string; q?: string; customer_id?: string } = {}) =>
    api.get<SalesOrder[]>(`${B}/sales-orders${qs(p)}`),
  salesOrder: (id: string) => api.get<SalesOrder>(`${B}/sales-orders/${id}`),
  saveSalesOrder: (body: Body, id?: string) =>
    id ? api.put<SalesOrder>(`${B}/sales-orders/${id}`, body) : api.post<SalesOrder>(`${B}/sales-orders`, body),
  salesOrderFromQuotation: (quotationId: string) =>
    api.post<SalesOrder>(`${B}/sales-orders/from-quotation`, { quotation_id: quotationId }),
  salesOrderAction: (id: string, action: 'submit' | 'revise' | 'unreserve') =>
    api.post<SalesOrder>(`${B}/sales-orders/${id}/${action}`),
  decideSalesOrder: (id: string, approve: boolean, note?: string) =>
    api.post<SalesOrder>(`${B}/sales-orders/${id}/decide`, { approve, note }),
  holdSalesOrder: (id: string, hold: boolean, reason: string) =>
    api.post<SalesOrder>(`${B}/sales-orders/${id}/hold`, { hold, reason }),
  reserve: (id: string, warehouseId: string) => api.post<SalesOrder>(`${B}/sales-orders/${id}/reserve`, { warehouse_id: warehouseId }),
  shortageRequisition: (id: string) => api.post<Requisition>(`${B}/sales-orders/${id}/shortage-requisition`),
  salesOrderReason: (id: string, action: 'cancel' | 'close', reason: string) =>
    api.post<SalesOrder>(`${B}/sales-orders/${id}/${action}`, { reason }),
  milestoneReady: (id: string, evidence: string) => api.post<SalesOrder>(`${B}/milestones/${id}/ready`, { evidence }),

  dispatches: (p: { status?: string; uninvoiced?: boolean } = {}) => api.get<Dispatch[]>(`${B}/dispatches${qs(p)}`),
  createDispatch: (body: Body) => api.post<Dispatch>(`${B}/dispatches`, body),
  deliver: (id: string, body: Body) => api.post<Dispatch>(`${B}/dispatches/${id}/deliver`, body),
  cancelDispatch: (id: string, reason: string) => api.post<Dispatch>(`${B}/dispatches/${id}/cancel`, { reason }),

  invoices: (p: { kind?: string; status?: string; q?: string; outstanding_only?: boolean; customer_id?: string } = {}) =>
    api.get<Invoice[]>(`${B}/invoices${qs(p)}`),
  invoice: (id: string) => api.get<Invoice>(`${B}/invoices/${id}`),
  ageing: () => api.get<Ageing>(`${B}/invoices/ageing`),
  saveInvoice: (body: Body, id?: string) =>
    id ? api.put<Invoice>(`${B}/invoices/${id}`, body) : api.post<Invoice>(`${B}/invoices`, body),
  invoiceFromDispatch: (dispatchId: string) => api.post<Invoice>(`${B}/invoices/from-dispatch`, { dispatch_id: dispatchId }),
  invoiceFromMilestone: (milestoneId: string) =>
    api.post<Invoice>(`${B}/invoices/from-milestone`, { milestone_id: milestoneId }),
  postInvoice: (id: string) => api.post<Invoice>(`${B}/invoices/${id}/post`),
  cancelInvoice: (id: string, reason: string) => api.post<Invoice>(`${B}/invoices/${id}/cancel`, { reason }),
  deleteInvoice: (id: string) => api.del(`${B}/invoices/${id}`),
  createCreditNote: (body: Body) => api.post<Invoice>(`${B}/credit-notes`, body),
  decideCreditNote: (id: string, approve: boolean, note?: string) =>
    api.post<Invoice>(`${B}/credit-notes/${id}/decide`, { approve, note }),
  recordReceipt: (body: Body) => api.post<Invoice>(`${B}/receipts`, body),
  reverseReceipt: (id: string, reason: string) => api.post<Invoice>(`${B}/receipts/${id}/reverse`, { reason }),
}

/* ---------------------------------------------------------------- helpers --- */

/** "6.000" → "6", "2.500" → "2.5". Quantities are stored to three places. */
export function qtyText(value: string | number | null | undefined): string {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString('en-IN', { maximumFractionDigits: 3 })
}

export const CONDITIONS = ['good', 'quarantine', 'defective', 'doa', 'rma', 'demo', 'scrap'] as const

export const FLOW_LABEL: Record<PendingApproval['kind'], string> = {
  purchase_requisition: 'Requisition',
  purchase_order: 'Purchase order',
  stock_adjustment: 'Stock adjustment',
  sales_order: 'Sales order',
  credit_note: 'Credit note',
}
