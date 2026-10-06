import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateOrder, confirmOrder, createCustomsDeclaration, createOrder, createOrderAsync, decideApproval, dispatchOrder, generateInvoice, getOrder, importOrdersAsync, listOutbox, operationSummary, publishOutbox, recordPayment, ReferenceConflictError, state, updateCustoms, updateOrder, updateOrderAsync } from './domain.js';

test('order lifecycle preserves credit, inventory, customs, shipment and invoice invariants', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `TEST-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  assert.equal(order.status, 'draft');
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  updateCustoms('tenant-acme', declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester');
  const dispatched = dispatchOrder('tenant-acme', order.id, 'tester');
  assert.equal(dispatched.status, 'dispatched');
  const invoice = generateInvoice('tenant-acme', order.id, 'tester');
  assert.ok(invoice.total > invoice.subtotal);
  recordPayment('tenant-acme', { invoiceId: invoice.id, amount: invoice.total, method: 'bank_transfer', reference: `PAY-${Date.now()}` }, 'tester');
  assert.equal(state.invoices.find(item => item.id === invoice.id)?.status, 'paid');
});

test('credit overage creates approval and approval increases only the required limit', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-002', reference: `CREDIT-${Date.now()}`, origin: '深圳', destination: '洛杉矶', items: [{ description: '控制模块', sku: 'CONTROL-M2', quantity: 10, unitPrice: 420, weightKg: 2, hsCode: '8537.10' }] });
  assert.throws(() => confirmOrder('tenant-acme', order.id, 'tester'), /需要审批/);
  const approval = state.approvals.find(item => item.orderId === order.id && item.type === 'credit_override');
  assert.ok(approval);
  decideApproval('tenant-acme', approval!.id, { status: 'approved', comment: '额度复核通过' }, 'finance');
  assert.doesNotThrow(() => confirmOrder('tenant-acme', order.id, 'finance'));
});

test('operation summary exposes receivable and reservation metrics', () => {
  const summary = operationSummary('tenant-acme');
  assert.ok(summary.orderCount >= 1);
  assert.ok(summary.receivable >= 0);
  assert.ok(summary.inventory.every(item => item.available >= item.reserved));
});

const baseInput = (reference: string) => ({
  customerId: 'CUS-001',
  reference,
  origin: '宁波',
  destination: '汉堡',
  items: [{ sku: 'SENSOR-X9', description: '温度传感器', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }]
});

test('customer reference is unique only within a tenant and same-payload requests are idempotent', async () => {
  const reference = `UNIQUE-${Date.now()}`;
  const input = baseInput(reference);
  const [first, retry, otherTenant] = await Promise.all([
    createOrderAsync('tenant-acme', input, 'erp'),
    createOrderAsync('tenant-acme', input, 'helpdesk'),
    createOrderAsync('tenant-globex', { ...input, customerId: 'CUS-101' }, 'batch')
  ]);

  assert.equal(retry.id, first.id);
  assert.notEqual(otherTenant.id, first.id);
  assert.equal(otherTenant.tenantId, 'tenant-globex');
  assert.equal(state.orders.filter(order => order.reference === reference).length, 2);
  assert.equal(state.outbox.filter(event => event.aggregateId === first.id).length, 1);

  await assert.rejects(createOrderAsync('tenant-acme', {
    ...input,
    items: [{ ...input.items[0]!, quantity: 3 }]
  }, 'helpdesk'), (error: unknown) => {
    assert.ok(error instanceof ReferenceConflictError);
    assert.equal(error.existingOrderId, first.id);
    assert.match(error.reason, /items/);
    return true;
  });

  const conflictAudit = state.audit.find(item => item.entityId === first.id && item.action === 'order.reference_conflict');
  assert.ok(conflictAudit);
  assert.equal(conflictAudit?.tenantId, 'tenant-acme');
  assert.equal(state.orders.filter(order => order.reference === reference && order.tenantId === 'tenant-acme').length, 1);
});

test('update keeps the tenant-scoped reference index, audit and outbox consistent', async () => {
  const original = await createOrderAsync('tenant-acme', baseInput(`UPDATE-${Date.now()}`), 'erp');
  const nextReference = `${original.reference}-FIXED`;
  const updated = await updateOrderAsync('tenant-acme', original.id, { reference: nextReference }, 'helpdesk');

  assert.equal(updated.reference, nextReference);
  assert.equal(state.orders.filter(order => order.reference === original.reference).length, 0);
  assert.ok(state.customerReferences.get('tenant-acme')?.get(nextReference));
  assert.ok(state.audit.some(item => item.entityId === original.id && item.action === 'order.updated'));
  assert.ok(state.outbox.some(event => event.aggregateId === original.id && event.topic === 'order.updated'));

  const retry = updateOrder('tenant-acme', original.id, { reference: nextReference });
  assert.equal(retry.id, original.id);
  assert.equal(state.audit.filter(item => item.entityId === original.id && item.action === 'order.updated').length, 1);

  const holder = await createOrderAsync('tenant-acme', baseInput(`UPDATE-HOLDER-${Date.now()}`), 'erp');
  assert.throws(() => updateOrder('tenant-acme', original.id, { reference: holder.reference }), ReferenceConflictError);
  assert.ok(state.audit.some(item => item.entityId === holder.id && item.action === 'order.reference_conflict'));
});

test('batch import creates, reuses and reports conflicts without leaking across tenants', async () => {
  const suffix = Date.now();
  const sharedReference = `IMPORT-SHARED-${suffix}`;
  const conflictReference = `IMPORT-CONFLICT-${suffix}`;
  await createOrderAsync('tenant-acme', baseInput(conflictReference), 'erp');

  const result = await importOrdersAsync('tenant-acme', [
    baseInput(sharedReference),
    baseInput(sharedReference),
    { ...baseInput(conflictReference), items: [{ ...baseInput(conflictReference).items[0]!, quantity: 9 }] }
  ], 'batch');

  assert.equal(result.imported, 1);
  assert.equal(result.reused, 1);
  assert.equal(result.rejected, 1);
  assert.equal(result.results[0]?.status, 'created');
  assert.equal(result.results[1]?.status, 'reused');
  assert.equal(result.results[1]?.orderId, result.results[0]?.orderId);
  assert.equal(result.results[2]?.status, 'rejected');
  assert.equal(result.results[2]?.code, 'CUSTOMER_REFERENCE_CONFLICT');

  const otherTenant = await importOrdersAsync('tenant-globex', [{ ...baseInput(sharedReference), customerId: 'CUS-101' }], 'batch');
  assert.equal(otherTenant.imported, 1);
  assert.equal(state.customerReferences.get('tenant-acme')?.get(sharedReference)?.orderId, result.results[0]?.orderId);
  assert.notEqual(state.customerReferences.get('tenant-globex')?.get(sharedReference)?.orderId, result.results[0]?.orderId);
});

test('outbox lists, publishes and retries only caller tenant events', async () => {
  const acme = await createOrderAsync('tenant-acme', baseInput(`OUTBOX-A-${Date.now()}`), 'erp');
  const globex = await createOrderAsync('tenant-globex', { ...baseInput(`OUTBOX-B-${Date.now()}`), customerId: 'CUS-101' }, 'batch');

  const acmeEvents = listOutbox('tenant-acme');
  assert.ok(acmeEvents.some(event => event.id === state.outbox.find(item => item.aggregateId === acme.id)?.id));
  assert.ok(!acmeEvents.some(event => event.aggregateId === globex.id));
  const globexEventId = state.outbox.find(item => item.aggregateId === globex.id)!.id;
  assert.throws(() => publishOutbox('tenant-acme', globexEventId), /记录不存在/);

  const eventId = state.outbox.find(item => item.aggregateId === acme.id)!.id;
  publishOutbox('tenant-acme', eventId, 'worker');
  publishOutbox('tenant-acme', eventId, 'worker');
  assert.equal(state.audit.filter(item => item.entityId === eventId && item.action === 'outbox.published').length, 1);
  assert.throws(() => getOrder('tenant-globex', acme.id), /订单不存在/);
});
