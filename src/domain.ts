import { createHash, randomUUID } from 'node:crypto';

export type OrderStatus = 'draft' | 'confirmed' | 'allocated' | 'dispatched' | 'delivered' | 'closed' | 'cancelled';
export type CustomsStatus = 'draft' | 'submitted' | 'inspection' | 'cleared' | 'rejected';
export type InvoiceStatus = 'issued' | 'partially_paid' | 'paid' | 'void';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

type Tenant = { id: string; name: string; creditLimit: number; creditUsed: number; currency: string };
type Customer = { id: string; tenantId: string; name: string; creditLimit: number; creditUsed: number; blocked: boolean; timezone?: string };
type OrderItem = { sku: string; description: string; quantity: number; unitPrice: number; weightKg: number; hsCode: string };
export type Order = { id: string; tenantId: string; customerId: string; reference: string; origin: string; destination: string; priority: 'standard' | 'urgent' | 'critical'; status: OrderStatus; items: OrderItem[]; totalWeightKg: number; subtotal: number; totalAmount: number; currency: string; version: number; shipmentId?: string; customsDeclarationId?: string; invoiceId?: string; createdAt: string; updatedAt: string };
export type OrderInput = { customerId: string; reference: string; origin: string; destination: string; priority?: Order['priority']; items: OrderItem[]; currency?: string };
export type OrderPatch = Partial<Pick<OrderInput, 'customerId' | 'reference' | 'origin' | 'destination' | 'priority' | 'items' | 'currency'>>;
type CustomerReferenceBinding = { orderId: string; customerId: string };
type CustomerReferenceIndex = Map<string, Map<string, CustomerReferenceBinding>>;
type InventoryLot = { id: string; tenantId: string; warehouse: string; sku: string; available: number; reserved: number; lotCode: string; expiresAt?: string };
type Reservation = { id: string; tenantId: string; orderId: string; lotId: string; sku: string; quantity: number; status: 'active' | 'released' | 'consumed'; createdAt: string };
type ShipmentLeg = { id: string; mode: 'truck' | 'rail' | 'sea' | 'air'; origin: string; destination: string; plannedDeparture: string; plannedArrival: string; actualArrival?: string; status: 'planned' | 'in_transit' | 'arrived' | 'delayed' };
type Shipment = { id: string; tenantId: string; orderId: string; trackingNo: string; legs: ShipmentLeg[]; currentLocation: string; eta: string; status: 'planned' | 'in_transit' | 'delivered' | 'exception'; events: { id: string; code: string; location: string; occurredAt: string; note?: string }[] };
type CustomsDeclaration = { id: string; tenantId: string; orderId: string; country: string; status: CustomsStatus; documentRefs: string[]; requiredDocuments: string[]; riskScore: number; rejectionReason?: string; updatedAt: string };
type InvoiceLine = { code: string; description: string; quantity: number; unitPrice: number; amount: number };
type Invoice = { id: string; tenantId: string; orderId: string; number: string; status: InvoiceStatus; currency: string; lines: InvoiceLine[]; subtotal: number; tax: number; total: number; paid: number; dueDate: string; createdAt: string };
type Payment = { id: string; tenantId: string; invoiceId: string; amount: number; method: 'bank_transfer' | 'card' | 'credit_note'; reference: string; receivedAt: string };
type Approval = { id: string; tenantId: string; orderId: string; type: 'credit_override' | 'customs_exception' | 'delay_compensation'; reason: string; status: ApprovalStatus; decidedBy?: string; comment?: string; createdAt: string; decidedAt?: string };
export type AuditEvent = { id: string; tenantId: string; actor: string; action: string; entityType: string; entityId: string; before?: unknown; after?: unknown; at: string };
export type OutboxEvent = { id: string; tenantId: string; topic: string; aggregateId: string; payload: unknown; status: 'pending' | 'published'; attempts: number; createdAt: string };

type State = { tenants: Tenant[]; customers: Customer[]; orders: Order[]; customerReferences: CustomerReferenceIndex; inventory: InventoryLot[]; reservations: Reservation[]; shipments: Shipment[]; customs: CustomsDeclaration[]; invoices: Invoice[]; payments: Payment[]; approvals: Approval[]; audit: AuditEvent[]; outbox: OutboxEvent[] };
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const id = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
const money = (value: number) => Math.round(value * 100) / 100;

export class ReferenceConflictError extends Error {
  code = 'CUSTOMER_REFERENCE_CONFLICT';
  status = 409;
  existingOrderId: string;
  reason: string;
  constructor(existingOrderId: string, reason: string) {
    super(`客户参考号与订单 ${existingOrderId} 的内容冲突：${reason}`);
    this.name = 'ReferenceConflictError';
    this.existingOrderId = existingOrderId;
    this.reason = reason;
  }
}

export const state: State = {
  tenants: [{ id: 'tenant-acme', name: 'Acme Global Trading', creditLimit: 250000, creditUsed: 36200, currency: 'USD' }, { id: 'tenant-globex', name: 'Globex Trade Partners', creditLimit: 180000, creditUsed: 0, currency: 'USD' }],
  customers: [{ id: 'CUS-001', tenantId: 'tenant-acme', name: 'Northstar Retail GmbH', creditLimit: 100000, creditUsed: 12000, blocked: false, timezone: 'Europe/Berlin' }, { id: 'CUS-002', tenantId: 'tenant-acme', name: 'Pacific Parts Inc.', creditLimit: 50000, creditUsed: 49000, blocked: false, timezone: 'America/Los_Angeles' }, { id: 'CUS-101', tenantId: 'tenant-globex', name: 'Meridian Imports Ltd.', creditLimit: 75000, creditUsed: 0, blocked: false, timezone: 'Europe/London' }],
  orders: [],
  // 业务唯一索引：(tenantId, customerReference) -> orderId，不能只按 reference 全局唯一。
  customerReferences: new Map(),
  inventory: [
    { id: 'LOT-001', tenantId: 'tenant-acme', warehouse: 'SHANGHAI-FTZ', sku: 'SENSOR-X9', available: 80, reserved: 10, lotCode: 'SX9-2608' },
    { id: 'LOT-002', tenantId: 'tenant-acme', warehouse: 'SHANGHAI-FTZ', sku: 'CONTROL-M2', available: 36, reserved: 4, lotCode: 'CM2-2607' },
    { id: 'LOT-003', tenantId: 'tenant-acme', warehouse: 'ROTTERDAM-DC', sku: 'SENSOR-X9', available: 12, reserved: 0, lotCode: 'SX9-2606' }
  ], reservations: [], shipments: [], customs: [], invoices: [], payments: [], approvals: [], audit: [], outbox: []
};

function tenant(id: string) { const value = state.tenants.find(item => item.id === id); if (!value) throw new Error('租户不存在'); return value; }
function assertTenant<T extends { tenantId: string }>(item: T, tenantId: string) { if (item.tenantId !== tenantId) throw new Error('记录不存在'); return item; }
function customerFor(tenantId: string, customerId: string) { const customer = state.customers.find(item => item.id === customerId && item.tenantId === tenantId); if (!customer) throw new Error('客户不存在'); return customer; }
function orderFor(tenantId: string, orderId: string) { const order = state.orders.find(item => item.id === orderId && item.tenantId === tenantId); if (!order) throw new Error('订单不存在'); return order; }
function requiredText(value: unknown, label: string) { if (typeof value !== 'string') throw new Error(`${label}不能为空`); const text = value.trim(); if (!text) throw new Error(`${label}不能为空`); return text; }
function normalizeItems(items: NonNullable<OrderInput['items']>) {
  if (!Array.isArray(items) || !items.length) throw new Error('订单明细不能为空');
  return items.map(item => {
    if (!item || typeof item !== 'object') throw new Error('订单明细不合法');
    if (typeof item.sku !== 'string' || !item.sku || !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.unitPrice) || item.unitPrice < 0 || !Number.isFinite(item.weightKg) || item.weightKg <= 0) throw new Error('订单明细数量、价格和重量必须为正数');
    return { sku: item.sku, description: item.description ?? item.sku, quantity: item.quantity, unitPrice: item.unitPrice, weightKg: item.weightKg, hsCode: item.hsCode ?? '0000.00' };
  });
}
type OrderContent = { customerId: string; origin: string; destination: string; priority: Order['priority']; items: OrderItem[]; currency: string };
function orderContent(tenantId: string, input: OrderInput | OrderPatch, fallback?: Order): OrderContent {
  const items = input.items === undefined ? fallback?.items : normalizeItems(input.items);
  if (!items?.length) throw new Error('订单明细不能为空');
  const customerId = input.customerId ?? fallback?.customerId;
  const origin = input.origin === undefined ? fallback?.origin : requiredText(input.origin, '起运地');
  const destination = input.destination === undefined ? fallback?.destination : requiredText(input.destination, '目的地');
  const currency = input.currency === undefined ? (fallback?.currency ?? tenant(tenantId).currency) : requiredText(input.currency, '币种');
  if (!customerId || !origin || !destination || !currency) throw new Error('订单内容不完整');
  return { customerId, origin, destination, priority: (input.priority ?? fallback?.priority ?? 'standard'), items, currency };
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function fingerprintContent(content: ReturnType<typeof orderContent>) { return createHash('sha256').update(stableStringify(content)).digest('hex'); }
function referenceIndex(tenantId: string) { let index = state.customerReferences.get(tenantId); if (!index) { index = new Map(); state.customerReferences.set(tenantId, index); } return index; }
function bindCustomerReference(tenantId: string, reference: string, binding: CustomerReferenceBinding) { const index = referenceIndex(tenantId); const existing = index.get(reference); if (existing && existing.orderId !== binding.orderId) throw new ReferenceConflictError(existing.orderId, '客户参考号已在租户内被其他订单占用'); index.set(reference, binding); }
function unbindCustomerReference(tenantId: string, reference: string, orderId: string) { const existing = referenceIndex(tenantId).get(reference); if (existing?.orderId === orderId) state.customerReferences.get(tenantId)!.delete(reference); }
function contentDifferences(candidate: ReturnType<typeof orderContent>, existing: Order) {
  const differences: string[] = [];
  const current = orderContent(existing.tenantId, { customerId: existing.customerId, origin: existing.origin, destination: existing.destination, priority: existing.priority, items: existing.items, currency: existing.currency });
  for (const key of Object.keys(candidate) as (keyof typeof candidate)[]) {
    if (stableStringify(candidate[key]) !== stableStringify(current[key])) differences.push(key);
  }
  return differences;
}
function recordReferenceConflict(tenantId: string, actor: string, reference: string, existingOrderId: string, candidate: ReturnType<typeof orderContent>, reason: string) {
  record(tenantId, actor, 'order.reference_conflict', 'order', existingOrderId, undefined, { reference, reason, contentFingerprint: fingerprintContent(candidate), at: now() });
}
function record(tenantId: string, actor: string, action: string, entityType: string, entityId: string, before?: unknown, after?: unknown) { state.audit.unshift({ id: id('AUD'), tenantId, actor, action, entityType, entityId, before: before === undefined ? undefined : clone(before), after: after === undefined ? undefined : clone(after), at: now() }); }
function emit(tenantId: string, topic: string, aggregateId: string, payload: unknown) { state.outbox.unshift({ id: id('EVT'), tenantId, topic, aggregateId, payload: clone(payload), status: 'pending', attempts: 0, createdAt: now() }); }
function mutate(tenantId: string, actor: string, action: string, type: string, entityId: string, before: unknown, after: unknown, topic: string) { record(tenantId, actor, action, type, entityId, before, after); if (action !== 'order.confirmed') emit(tenantId, topic, entityId, after); }
function transition(order: Order, next: OrderStatus) { const allowed: Record<OrderStatus, OrderStatus[]> = { draft: ['confirmed', 'cancelled'], confirmed: ['allocated', 'cancelled'], allocated: ['dispatched', 'cancelled'], dispatched: ['delivered'], delivered: ['closed', 'dispatched'], closed: [], cancelled: [] }; if (!allowed[order.status].includes(next)) throw new Error(`订单不能从 ${order.status} 变更为 ${next}`); order.status = next; order.version += 1; order.updatedAt = now(); }

export function listOrders(tenantId: string, filters: { status?: string; customerId?: string; q?: string } = {}) { tenant(tenantId); return state.orders.filter(item => item.tenantId === tenantId && (!filters.status || item.status === filters.status) && (!filters.customerId || item.customerId === filters.customerId) && (!filters.q || `${item.reference} ${item.destination}`.toLowerCase().includes(filters.q.toLowerCase()))).map(clone); }
export function getOrder(tenantId: string, orderId: string) { return clone(orderFor(tenantId, orderId)); }
function buildOrder(tenantId: string, input: Partial<Order>): { order: Order; content: OrderContent } {
  tenant(tenantId);
  const customerId = requiredText(input.customerId, '客户');
  const reference = requiredText(input.reference, '客户参考号');
  const origin = requiredText(input.origin, '起运地');
  const destination = requiredText(input.destination, '目的地');
  if (input.priority && !['standard', 'urgent', 'critical'].includes(input.priority)) throw new Error('订单优先级不合法');
  const items = normalizeItems(input.items ?? []);
  const content = orderContent(tenantId, { customerId, reference, origin, destination, priority: input.priority, items, currency: input.currency });
  // 先确认客户归属，再查询租户内参考号，避免把其他租户客户或编号细节写入响应。
  customerFor(tenantId, content.customerId);
  const timestamp = now();
  const subtotal = money(items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
  return {
    order: {
      id: id('ORD'), tenantId, customerId: content.customerId, reference, origin: content.origin!, destination: content.destination!,
      priority: content.priority, status: 'draft', items, totalWeightKg: money(items.reduce((sum, item) => sum + item.quantity * item.weightKg, 0)),
      subtotal, totalAmount: subtotal, currency: content.currency!, version: 1, createdAt: timestamp, updatedAt: timestamp
    },
    content
  };
}
export function createOrder(tenantId: string, input: Partial<Order>, actor = 'system') {
  tenant(tenantId);
  const reference = requiredText(input.reference, '客户参考号');
  const { order, content } = buildOrder(tenantId, input);
  const index = referenceIndex(tenantId);
  const binding = index.get(reference);
  if (binding) {
    const existing = state.orders.find(item => item.id === binding.orderId && item.tenantId === tenantId);
    if (!existing) throw new Error('客户参考号索引不一致');
    const differences = contentDifferences(content, existing);
    if (differences.length) {
      const reason = `提交内容与既有订单不一致：${differences.join('、')}`;
      recordReferenceConflict(tenantId, actor, reference, existing.id, content, reason);
      throw new ReferenceConflictError(existing.id, reason);
    }
    // 同租户、同编号且业务内容一致：重试/并发请求复用同一订单，不重复写 audit/outbox。
    return clone(existing);
  }

  const audit: AuditEvent = { id: id('AUD'), tenantId, actor, action: 'order.created', entityType: 'order', entityId: order.id, after: clone(order), at: now() };
  const event: OutboxEvent = { id: id('EVT'), tenantId, topic: 'order.created', aggregateId: order.id, payload: clone(order), status: 'pending', attempts: 0, createdAt: now() };
  // 唯一索引、订单、audit、outbox 在一个同步临界区内提交；并发 wrapper 只会串行执行到这里。
  bindCustomerReference(tenantId, reference, { orderId: order.id, customerId: order.customerId });
  state.orders.unshift(order);
  state.audit.unshift(audit);
  state.outbox.unshift(event);
  return clone(order);
}

export function updateOrder(tenantId: string, orderId: string, patch: OrderPatch, actor = 'system') {
  const existing = orderFor(tenantId, orderId);
  const nextReference = patch.reference === undefined ? existing.reference : requiredText(patch.reference, '客户参考号');
  if (patch.priority && !['standard', 'urgent', 'critical'].includes(patch.priority)) throw new Error('订单优先级不合法');
  const content = orderContent(tenantId, patch, existing);
  customerFor(tenantId, content.customerId);

  const binding = referenceIndex(tenantId).get(nextReference);
  if (binding && binding.orderId !== existing.id) {
    const reason = '客户参考号已在租户内被其他订单占用';
    recordReferenceConflict(tenantId, actor, nextReference, binding.orderId, content, reason);
    throw new ReferenceConflictError(binding.orderId, reason);
  }

  const differences = contentDifferences(content, existing);
  if (nextReference === existing.reference && differences.length === 0) return clone(existing);
  if (existing.status !== 'draft') throw new Error('仅 draft 订单可以修改商业内容或客户参考号');

  const before = clone(existing);
  const items = content.items;
  const subtotal = money(items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
  const updated: Order = {
    ...clone(existing),
    customerId: content.customerId,
    reference: nextReference,
    origin: content.origin!,
    destination: content.destination!,
    priority: content.priority,
    items,
    totalWeightKg: money(items.reduce((sum, item) => sum + item.quantity * item.weightKg, 0)),
    subtotal,
    totalAmount: subtotal,
    currency: content.currency!,
    version: existing.version + 1,
    updatedAt: now()
  };
  const audit: AuditEvent = { id: id('AUD'), tenantId, actor, action: 'order.updated', entityType: 'order', entityId: existing.id, before, after: clone(updated), at: now() };
  const event: OutboxEvent = { id: id('EVT'), tenantId, topic: 'order.updated', aggregateId: existing.id, payload: clone(updated), status: 'pending', attempts: 0, createdAt: now() };

  // 先检查新 (tenantId, reference)，再移动索引并提交订单/audit/outbox。
  bindCustomerReference(tenantId, nextReference, { orderId: existing.id, customerId: updated.customerId });
  unbindCustomerReference(tenantId, existing.reference, existing.id);
  Object.assign(existing, updated);
  state.audit.unshift(audit);
  state.outbox.unshift(event);
  return clone(existing);
}

let orderWriteChain: Promise<unknown> = Promise.resolve();
function serializeOrderWrite<T>(operation: () => T): Promise<T> {
  const run = orderWriteChain.then(operation);
  orderWriteChain = run.then(() => undefined, () => undefined);
  return run;
}
export function createOrderAsync(tenantId: string, input: Partial<Order>, actor = 'system') {
  return serializeOrderWrite(() => createOrder(tenantId, input, actor));
}
export function updateOrderAsync(tenantId: string, orderId: string, patch: OrderPatch, actor = 'system') {
  return serializeOrderWrite(() => updateOrder(tenantId, orderId, patch, actor));
}

export type OrderImportRow = Partial<Order> & { rowNumber?: number };
export type OrderImportResult = {
  rowNumber: number;
  reference?: string;
  status: 'created' | 'reused' | 'rejected';
  orderId?: string;
  reason?: string;
  code?: string;
};
export function importOrders(tenantId: string, rows: OrderImportRow[], actor = 'batch-import'): { imported: number; reused: number; rejected: number; results: OrderImportResult[] } {
  tenant(tenantId);
  if (!Array.isArray(rows)) throw new Error('导入数据必须是数组');
  const results = rows.map((row, index) => {
    const rowNumber = row.rowNumber ?? index + 1;
    const reference = typeof row.reference === 'string' ? row.reference.trim() : undefined;
    try {
      const before = reference ? referenceIndex(tenantId).get(reference) : undefined;
      const order = createOrder(tenantId, row, actor);
      const status = before ? 'reused' : 'created';
      return { rowNumber, reference: order.reference, status, orderId: order.id } as OrderImportResult;
    } catch (error) {
      const rejected: OrderImportResult = {
        rowNumber,
        reference,
        status: 'rejected',
        reason: error instanceof Error ? error.message : '导入失败',
        code: error instanceof ReferenceConflictError ? error.code : 'INVALID_ORDER'
      };
      return rejected;
    }
  });
  return {
    imported: results.filter(item => item.status === 'created').length,
    reused: results.filter(item => item.status === 'reused').length,
    rejected: results.filter(item => item.status === 'rejected').length,
    results
  };
}
export function importOrdersAsync(tenantId: string, rows: OrderImportRow[], actor = 'batch-import') {
  return serializeOrderWrite(() => importOrders(tenantId, rows, actor));
}
export function confirmOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const before = clone(order); const customer = customerFor(tenantId, order.customerId); if (customer.blocked) throw new Error('客户已被风控冻结'); if (customer.creditUsed + order.totalAmount > customer.creditLimit) { const approval = createApproval(tenantId, { orderId, type: 'credit_override', reason: '订单金额超过客户授信额度' }, actor); throw new Error(`客户授信不足，需要审批 ${approval.id}`); } transition(order, 'confirmed'); customer.creditUsed = money(customer.creditUsed + order.totalAmount); mutate(tenantId, actor, 'order.confirmed', 'order', order.id, before, order, 'order.confirmed'); return clone(order); }
export function allocateOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const before = clone(order); const allocations: Reservation[] = []; for (const item of order.items) { let remaining = item.quantity; for (const lot of state.inventory.filter(value => value.tenantId === tenantId && value.sku === item.sku && value.available - value.reserved > 0)) { const qty = Math.min(remaining, lot.available); lot.reserved += qty; remaining -= qty; allocations.push({ id: id('RSV'), tenantId, orderId, lotId: lot.id, sku: item.sku, quantity: qty, status: 'active', createdAt: now() }); if (!remaining) break; } if (remaining) { for (const allocation of allocations) { const lot = state.inventory.find(value => value.id === allocation.lotId)!; lot.reserved -= allocation.quantity; } throw new Error(`库存不足：${item.sku} 还缺少 ${remaining}`); } } state.reservations.push(...allocations); transition(order, 'allocated'); mutate(tenantId, actor, 'order.allocated', 'order', order.id, before, { order, allocations }, 'inventory.reserved'); return clone(order); }
export function dispatchOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const customs = state.customs.find(item => item.tenantId === tenantId && item.orderId === order.id); if (!customs || customs.status !== 'cleared') throw new Error('海关申报尚未放行'); const reservations = state.reservations.filter(item => item.tenantId === tenantId && item.orderId === orderId && item.status === 'active'); if (!reservations.length) throw new Error('订单没有有效库存分配'); const before = clone(order); transition(order, 'dispatched'); reservations.forEach(reservation => { const lot = state.inventory.find(item => item.id === reservation.lotId)!; lot.available -= reservation.quantity; lot.reserved -= reservation.quantity; reservation.status = 'consumed'; }); const shipment: Shipment = { id: id('SHP'), tenantId, orderId, trackingNo: `CBF${Date.now().toString().slice(-8)}`, legs: [{ id: id('LEG'), mode: 'truck', origin: order.origin, destination: '出口口岸', plannedDeparture: now(), plannedArrival: new Date(Date.now() + 86400000).toISOString(), status: 'planned' }, { id: id('LEG'), mode: 'sea', origin: '出口口岸', destination: order.destination, plannedDeparture: new Date(Date.now() + 172800000).toISOString(), plannedArrival: new Date(Date.now() + 10 * 86400000).toISOString(), status: 'planned' }], currentLocation: order.origin, eta: new Date(Date.now() + 10 * 86400000).toISOString(), status: 'planned', events: [] }; state.shipments.push(shipment); order.shipmentId = shipment.id; mutate(tenantId, actor, 'order.dispatched', 'order', order.id, before, { order, shipment }, 'shipment.created'); return clone(order); }
export function deliverOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const shipment = state.shipments.find(item => item.tenantId === tenantId && item.orderId === orderId); if (!shipment) throw new Error('运输单不存在'); const before = clone(order); transition(order, 'delivered'); shipment.status = 'delivered'; shipment.currentLocation = order.destination; shipment.events.push({ id: id('TRK'), code: 'DELIVERED', location: order.destination, occurredAt: now(), note: '签收完成' }); mutate(tenantId, actor, 'order.delivered', 'order', order.id, before, { order, shipment }, 'shipment.delivered'); return clone(order); }
export function closeOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const invoice = state.invoices.find(item => item.tenantId === tenantId && item.orderId === orderId); if (!invoice || invoice.status !== 'paid') throw new Error('发票未完成收款核销'); const before = clone(order); transition(order, 'closed'); const customer = customerFor(tenantId, order.customerId); customer.creditUsed = money(Math.max(0, customer.creditUsed - order.totalAmount)); mutate(tenantId, actor, 'order.closed', 'order', order.id, before, order, 'order.closed'); return clone(order); }
export function cancelOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const before = clone(order); if (['dispatched', 'delivered', 'closed'].includes(order.status)) throw new Error('已出运订单不能取消'); transition(order, 'cancelled'); const reservation = state.reservations.find(item => item.tenantId === tenantId && item.orderId === orderId && item.status === 'active'); if (reservation) { state.inventory.find(lot => lot.id === reservation.lotId)!.reserved -= reservation.quantity; reservation.status = 'released'; } const customer = customerFor(tenantId, order.customerId); if (before.status !== 'draft') customer.creditUsed = money(Math.max(0, customer.creditUsed - order.totalAmount)); mutate(tenantId, actor, 'order.cancelled', 'order', order.id, before, order, 'order.cancelled'); return clone(order); }

export function createCustomsDeclaration(tenantId: string, input: { orderId: string; country?: string; requiredDocuments?: string[] }, actor = 'system') { const order = orderFor(tenantId, input.orderId); if (state.customs.some(item => item.tenantId === tenantId && item.orderId === order.id)) throw new Error('订单已有海关申报'); const declaration: CustomsDeclaration = { id: id('CUS'), tenantId, orderId: order.id, country: input.country ?? order.destination, status: 'draft', documentRefs: [], requiredDocuments: input.requiredDocuments ?? ['commercial-invoice', 'packing-list', 'origin-certificate'], riskScore: order.priority === 'critical' ? 82 : order.totalWeightKg > 1000 ? 60 : 24, updatedAt: now() }; state.customs.push(declaration); order.customsDeclarationId = declaration.id; mutate(tenantId, actor, 'customs.created', 'customs', declaration.id, undefined, declaration, 'customs.created'); return clone(declaration); }
export function updateCustoms(tenantId: string, declarationId: string, input: { status?: CustomsStatus; documentRefs?: string[]; rejectionReason?: string }, actor = 'system') { const declaration = assertTenant(state.customs.find(item => item.id === declarationId) ?? (() => { throw new Error('海关申报不存在'); })(), tenantId); const before = clone(declaration); if (input.documentRefs) declaration.documentRefs = [...new Set(input.documentRefs)]; if (input.status) { if (input.status === 'cleared' && declaration.requiredDocuments.some(doc => !declaration.documentRefs.includes(doc))) throw new Error('放行前必须补齐所有必需单证'); if (input.status === 'inspection' && declaration.status !== 'submitted') throw new Error('只有已提交申报才能进入查验'); declaration.status = input.status; } declaration.rejectionReason = input.rejectionReason; declaration.updatedAt = now(); mutate(tenantId, actor, 'customs.updated', 'customs', declaration.id, before, declaration, 'customs.updated'); return clone(declaration); }
export function addShipmentEvent(tenantId: string, shipmentId: string, input: { code: string; location: string; occurredAt?: string; note?: string }, actor = 'system') { const shipment = assertTenant(state.shipments.find(item => item.id === shipmentId) ?? (() => { throw new Error('运输单不存在'); })(), tenantId); if (!input.code || !input.location) throw new Error('轨迹编码和位置不能为空'); const event = { id: id('TRK'), code: input.code, location: input.location, occurredAt: input.occurredAt ?? now(), note: input.note }; shipment.events.push(event); shipment.currentLocation = input.location; if (input.code === 'DEPARTED') { shipment.status = 'in_transit'; shipment.legs[0].status = 'in_transit'; } if (input.code === 'DELAYED') { shipment.status = 'exception'; shipment.legs.find(leg => leg.status !== 'arrived')!.status = 'delayed'; createApproval(tenantId, { orderId: shipment.orderId, type: 'delay_compensation', reason: `运输轨迹 ${shipment.trackingNo} 发生延误` }, actor); } if (input.code === 'ARRIVED') shipment.legs[shipment.legs.length - 1].status = 'arrived'; record(tenantId, actor, 'shipment.event.added', 'shipment', shipment.id, undefined, event); emit(tenantId, 'shipment.event.added', shipment.id, event); return clone(shipment); }

export function generateInvoice(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const existing = state.invoices.find(item => item.tenantId === tenantId && item.orderId === orderId); if (existing) return clone(existing); if (!['allocated', 'dispatched', 'delivered', 'closed'].includes(order.status)) throw new Error('订单完成库存分配后才能开票'); const freight = money(Math.max(120, order.totalWeightKg * (order.priority === 'critical' ? 4.2 : 2.1))); const fuel = money(freight * 0.13); const customsFee = money(95 + order.items.length * 25); const lines: InvoiceLine[] = [{ code: 'GOODS', description: '货物服务费', quantity: 1, unitPrice: order.subtotal, amount: order.subtotal }, { code: 'FREIGHT', description: '跨境运输费', quantity: 1, unitPrice: freight, amount: freight }, { code: 'FUEL', description: '燃油附加费', quantity: 1, unitPrice: fuel, amount: fuel }, { code: 'CUSTOMS', description: '关务服务费', quantity: 1, unitPrice: customsFee, amount: customsFee }]; const subtotal = money(lines.reduce((sum, line) => sum + line.amount, 0)); const tax = money(subtotal * 0.06); const invoice: Invoice = { id: id('INV'), tenantId, orderId, number: `INV-${new Date().getFullYear()}-${String(state.invoices.length + 1).padStart(5, '0')}`, status: 'issued', currency: order.currency, lines, subtotal, tax, total: money(subtotal + tax), paid: 0, dueDate: new Date(Date.now() + 30 * 86400000).toISOString(), createdAt: now() }; state.invoices.push(invoice); order.invoiceId = invoice.id; mutate(tenantId, actor, 'invoice.issued', 'invoice', invoice.id, undefined, invoice, 'invoice.issued'); return clone(invoice); }
export function recordPayment(tenantId: string, input: { invoiceId: string; amount: number; method: Payment['method']; reference: string }, actor = 'system') { const invoice = assertTenant(state.invoices.find(item => item.id === input.invoiceId) ?? (() => { throw new Error('发票不存在'); })(), tenantId); if (!input.amount || input.amount <= 0 || input.amount > invoice.total - invoice.paid + 0.01) throw new Error('收款金额超过发票未核销余额'); const before = clone(invoice); const payment: Payment = { id: id('PAY'), tenantId, invoiceId: invoice.id, amount: money(input.amount), method: input.method, reference: input.reference, receivedAt: now() }; state.payments.push(payment); invoice.paid = money(invoice.paid + payment.amount); invoice.status = invoice.paid >= invoice.total - 0.01 ? 'paid' : 'partially_paid'; if (invoice.status === 'paid') { const order = state.orders.find(item => item.tenantId === tenantId && item.id === invoice.orderId); if (order) order.status = 'closed'; } mutate(tenantId, actor, 'payment.recorded', 'invoice', invoice.id, before, invoice, 'payment.recorded'); return clone(payment); }

export function createApproval(tenantId: string, input: { orderId: string; type: Approval['type']; reason: string }, actor = 'system') { orderFor(tenantId, input.orderId); const approval: Approval = { id: id('APR'), tenantId, orderId: input.orderId, type: input.type, reason: input.reason, status: 'pending', createdAt: now() }; state.approvals.push(approval); record(tenantId, actor, 'approval.created', 'approval', approval.id, undefined, approval); emit(tenantId, 'approval.created', approval.id, approval); return clone(approval); }
export function decideApproval(tenantId: string, approvalId: string, input: { status: Exclude<ApprovalStatus, 'pending'>; comment?: string }, actor: string) { const approval = assertTenant(state.approvals.find(item => item.id === approvalId) ?? (() => { throw new Error('审批不存在'); })(), tenantId); if (approval.status !== 'pending') throw new Error('审批已经决策'); const before = clone(approval); approval.status = input.status; approval.decidedBy = actor; approval.comment = input.comment; approval.decidedAt = now(); if (input.status === 'approved' && approval.type === 'credit_override') { const order = orderFor(tenantId, approval.orderId); const customer = customerFor(tenantId, order.customerId); customer.creditLimit = Math.max(customer.creditLimit, customer.creditUsed + order.totalAmount); } mutate(tenantId, actor, 'approval.decided', 'approval', approval.id, before, approval, 'approval.decided'); return clone(approval); }

export function operationSummary(tenantId: string) { tenant(tenantId); const orders = listOrders(tenantId); const invoices = state.invoices.filter(item => item.tenantId === tenantId); const shipments = state.shipments.filter(item => item.tenantId === tenantId); return { tenantId, generatedAt: now(), orderCount: orders.length, byStatus: orders.reduce<Record<string, number>>((acc, item) => { acc[item.status] = (acc[item.status] ?? 0) + 1; return acc; }, {}), grossMerchandiseValue: money(orders.reduce((sum, item) => sum + item.totalAmount, 0)), receivable: money(invoices.reduce((sum, item) => sum + item.total - item.paid, 0)), paid: money(invoices.reduce((sum, item) => sum + item.paid, 0)), delayedShipments: shipments.filter(item => item.status === 'exception').length, pendingApprovals: state.approvals.filter(item => item.tenantId === tenantId && item.status === 'pending').length, inventory: state.inventory.filter(item => item.tenantId === tenantId).map(item => ({ warehouse: item.warehouse, sku: item.sku, available: item.available, reserved: item.reserved, free: item.available - item.reserved })) }; }
export function timeline(tenantId: string, orderId: string) { const order = orderFor(tenantId, orderId); const relatedIds = new Set([order.id]); const shipment = state.shipments.find(item => item.tenantId === tenantId && item.orderId === orderId); const customs = state.customs.find(item => item.tenantId === tenantId && item.orderId === orderId); const invoice = state.invoices.find(item => item.tenantId === tenantId && item.orderId === orderId); if (shipment) relatedIds.add(shipment.id); if (customs) relatedIds.add(customs.id); if (invoice) relatedIds.add(invoice.id); state.approvals.filter(item => item.tenantId === tenantId && item.orderId === orderId).forEach(item => relatedIds.add(item.id)); return state.audit.filter(item => item.tenantId === tenantId && relatedIds.has(item.entityId)).sort((a, b) => b.at.localeCompare(a.at)).map(clone); }
export function listAudit(tenantId: string, limit = 100) { tenant(tenantId); return state.audit.filter(item => item.tenantId === tenantId).slice(0, Math.min(limit, 500)).map(clone); }
export function listOutbox(tenantId: string, status?: OutboxEvent['status']) { tenant(tenantId); return state.outbox.filter(item => item.tenantId === tenantId && (!status || item.status === status)).map(clone); }
export function publishOutbox(tenantId: string, eventId: string, actor = 'system') { const event = assertTenant(state.outbox.find(item => item.id === eventId) ?? (() => { throw new Error('事件不存在'); })(), tenantId); if (event.status === 'published') return clone(event); event.status = 'published'; event.attempts += 1; record(tenantId, actor, 'outbox.published', 'outbox', event.id, { status: 'pending' }, event); return clone(event); }


export type OrderPage = { items: Order[]; nextCursor?: string; total: number };
export function listOrdersPage(tenantId: string, input: { cursor?: string; limit?: number } = {}) {
  tenant(tenantId);
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const offset = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
  const ordered = state.orders.filter(item => item.tenantId === tenantId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const items = ordered.slice(offset, offset + limit).map(clone);
  return { items, nextCursor: offset + limit < ordered.length ? String(offset + limit) : undefined, total: ordered.length };
}
export function invoiceOverdue(tenantId: string, invoiceId: string, asOf = new Date()) {
  const invoice = assertTenant(state.invoices.find(item => item.id === invoiceId) ?? (() => { throw new Error('发票不存在'); })(), tenantId);
  const order = orderFor(tenantId, invoice.orderId);
  const customer = customerFor(tenantId, order.customerId);
  const customerDate = asOf.toISOString().slice(0, 10);
  return { invoiceId, overdue: customerDate > invoice.dueDate.slice(0, 10), evaluatedDate: customerDate, customerTimezone: customer.timezone ?? 'UTC' };
}

// seed a coherent flow for demos: one order is allocated, one customs declaration is cleared, and one invoice is partially paid.
const seeded = createOrder('tenant-acme', { customerId: 'CUS-001', reference: 'PO-2026-0918', origin: '上海保税区', destination: '鹿特丹', priority: 'urgent', items: [{ sku: 'SENSOR-X9', description: '工业温度传感器', quantity: 10, unitPrice: 180, weightKg: 2.4, hsCode: '9025.19' }, { sku: 'CONTROL-M2', description: '边缘控制模块', quantity: 4, unitPrice: 420, weightKg: 3.2, hsCode: '8537.10' }] });
confirmOrder('tenant-acme', seeded.id); allocateOrder('tenant-acme', seeded.id); const seededDeclaration = createCustomsDeclaration('tenant-acme', { orderId: seeded.id }); updateCustoms('tenant-acme', seededDeclaration.id, { documentRefs: ['commercial-invoice', 'packing-list', 'origin-certificate'], status: 'submitted' }); updateCustoms('tenant-acme', seededDeclaration.id, { status: 'cleared' }); dispatchOrder('tenant-acme', seeded.id); const seededInvoice = generateInvoice('tenant-acme', seeded.id); recordPayment('tenant-acme', { invoiceId: seededInvoice.id, amount: 500, method: 'bank_transfer', reference: 'BANK-DEMO-001' });
