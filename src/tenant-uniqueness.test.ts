import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmOrder, createOrder, getOrder, getOrderByReference, importOrders, listAudit, listOrders, listOutbox, state, timeline, updateOrder } from './domain.js';

const OTHER_TENANT = 'tenant-globex';
const ensureSecondTenant = () => {
  if (!state.tenants.some(item => item.id === OTHER_TENANT)) {
    state.tenants.push({ id: OTHER_TENANT, name: 'Globex Trade Co', creditLimit: 200000, creditUsed: 0, currency: 'EUR' });
    state.customers.push({ id: 'CUS-G01', tenantId: OTHER_TENANT, name: 'Globex Retail BV', creditLimit: 80000, creditUsed: 0, blocked: false });
  }
};
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const sampleItems = () => [{ sku: 'SENSOR-X9', description: '工业温度传感器', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }];

test('different tenants may legitimately use the same customer reference', () => {
  ensureSecondTenant();
  const reference = `X-${uniq()}`;
  const first = createOrder('tenant-acme', { customerId: 'CUS-001', reference, origin: '上海', destination: '汉堡', items: sampleItems() });
  const second = createOrder(OTHER_TENANT, { customerId: 'CUS-G01', reference, origin: '深圳', destination: '洛杉矶', items: sampleItems() });
  assert.notEqual(first.id, second.id);
  assert.equal(getOrderByReference('tenant-acme', reference).id, first.id);
  assert.equal(getOrderByReference(OTHER_TENANT, reference).id, second.id);
  assert.equal(listOrders('tenant-acme', { q: reference }).length, 1);
  assert.equal(listOrders(OTHER_TENANT, { q: reference }).length, 1);
});

test('same tenant retry with identical content reuses the original order without duplicate side effects', async () => {
  const reference = `R-${uniq()}`;
  const input = { customerId: 'CUS-001', reference, origin: '上海', destination: '汉堡', items: sampleItems() };
  const first = createOrder('tenant-acme', input, 'erp');
  const retries = await Promise.all(Array.from({ length: 5 }, () => Promise.resolve().then(() => createOrder('tenant-acme', input, 'erp'))));
  assert.ok(retries.every(order => order.id === first.id));
  assert.equal(state.orders.filter(item => item.tenantId === 'tenant-acme' && item.reference === reference).length, 1);
  assert.equal(state.audit.filter(item => item.action === 'order.created' && item.entityId === first.id).length, 1);
  assert.equal(state.outbox.filter(item => item.topic === 'order.created' && item.aggregateId === first.id).length, 1);
  assert.equal(state.orders.find(item => item.id === first.id)!.version, 1);
});

test('same tenant conflicting content is rejected and the reason is recorded', () => {
  const reference = `C-${uniq()}`;
  const first = createOrder('tenant-acme', { customerId: 'CUS-001', reference, origin: '上海', destination: '汉堡', items: sampleItems() }, 'erp');
  const before = { orders: state.orders.length, outbox: state.outbox.length };
  assert.throws(() => createOrder('tenant-acme', { customerId: 'CUS-001', reference, origin: '上海', destination: '汉堡', items: [{ ...sampleItems()[0], quantity: 5 }] }, 'cs-desk'), /内容不一致/);
  assert.equal(state.orders.length, before.orders);
  assert.equal(state.outbox.length, before.outbox);
  const conflict = state.audit.find(item => item.action === 'order.reference.conflict' && item.entityId === first.id);
  assert.ok(conflict);
  assert.equal(conflict.tenantId, 'tenant-acme');
  assert.match(String((conflict.after as { reason?: string }).reason), /内容不一致/);
  assert.ok(timeline('tenant-acme', first.id).some(item => item.action === 'order.reference.conflict'));
});

test('uniqueness conflicts never leak other tenants data', () => {
  ensureSecondTenant();
  const reference = `L-${uniq()}`;
  const foreign = createOrder(OTHER_TENANT, { customerId: 'CUS-G01', reference, origin: '广州', destination: '纽约', items: sampleItems() }, 'erp');
  const mine = createOrder('tenant-acme', { customerId: 'CUS-001', reference, origin: '上海', destination: '汉堡', items: sampleItems() }, 'erp');
  let message = '';
  try {
    createOrder('tenant-acme', { customerId: 'CUS-001', reference, origin: '上海', destination: '汉堡', items: [{ ...sampleItems()[0], quantity: 9 }] }, 'erp');
  } catch (error) { message = (error as Error).message; }
  assert.match(message, /内容不一致/);
  assert.ok(!message.includes(foreign.id));
  assert.ok(!message.includes(OTHER_TENANT));
  assert.ok(!message.includes(mine.id));
  assert.throws(() => getOrder('tenant-acme', foreign.id), /订单不存在/);
});

test('update enforces the same tenant-scoped reference constraint and is retry safe', () => {
  const refA = `UA-${uniq()}`; const refB = `UB-${uniq()}`; const refC = `UC-${uniq()}`;
  const kept = createOrder('tenant-acme', { customerId: 'CUS-001', reference: refA, origin: '上海', destination: '汉堡', items: sampleItems() }, 'cs-desk');
  const moved = createOrder('tenant-acme', { customerId: 'CUS-001', reference: refB, origin: '上海', destination: '汉堡', items: sampleItems() }, 'cs-desk');
  assert.throws(() => updateOrder('tenant-acme', moved.id, { reference: refA }, 'cs-desk'), /已存在/);
  assert.equal(state.orders.find(item => item.id === moved.id)!.reference, refB);
  assert.ok(state.audit.some(item => item.action === 'order.reference.conflict' && item.entityId === kept.id));
  const renamed = updateOrder('tenant-acme', moved.id, { reference: refC, destination: '鹿特丹' }, 'cs-desk');
  assert.equal(renamed.reference, refC);
  assert.equal(renamed.version, 2);
  assert.throws(() => getOrderByReference('tenant-acme', refB), /订单不存在/);
  assert.equal(getOrderByReference('tenant-acme', refC).id, moved.id);
  const replay = updateOrder('tenant-acme', moved.id, { reference: refC, destination: '鹿特丹' }, 'cs-desk');
  assert.equal(replay.version, 2);
  assert.equal(state.audit.filter(item => item.action === 'order.updated' && item.entityId === moved.id).length, 1);
  const recycled = createOrder('tenant-acme', { customerId: 'CUS-001', reference: refB, origin: '宁波', destination: '新加坡', items: sampleItems() }, 'erp');
  assert.ok(recycled.id);
});

test('only draft orders can be updated', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `D-${uniq()}`, origin: '上海', destination: '汉堡', items: sampleItems() }, 'cs-desk');
  confirmOrder('tenant-acme', order.id, 'cs-desk');
  assert.throws(() => updateOrder('tenant-acme', order.id, { destination: '鹿特丹' }, 'cs-desk'), /草稿/);
});

test('bulk import is idempotent and reports per-entry outcomes', () => {
  const reference = `IM-${uniq()}`;
  createOrder('tenant-acme', { customerId: 'CUS-001', reference, origin: '上海', destination: '汉堡', items: sampleItems() }, 'erp');
  const batch = [
    { customerId: 'CUS-001', reference: `IM-A-${uniq()}`, origin: '上海', destination: '汉堡', items: sampleItems() },
    { customerId: 'CUS-001', reference: `IM-B-${uniq()}`, origin: '上海', destination: '汉堡', items: sampleItems() },
    { customerId: 'CUS-001', reference, origin: '上海', destination: '汉堡', items: sampleItems() },
    { customerId: 'CUS-001', reference, origin: '上海', destination: '汉堡', items: [{ ...sampleItems()[0], quantity: 7 }] },
    { customerId: 'CUS-001', reference: '', origin: '上海', destination: '汉堡', items: sampleItems() }
  ];
  const first = importOrders('tenant-acme', batch, 'import-job');
  assert.deepEqual(first.results.map(item => item.status), ['created', 'created', 'reused', 'rejected', 'rejected']);
  assert.equal(first.created, 2);
  const counts = { orders: state.orders.length, outbox: state.outbox.length };
  const second = importOrders('tenant-acme', batch, 'import-job');
  assert.deepEqual(second.results.map(item => item.status), ['reused', 'reused', 'reused', 'rejected', 'rejected']);
  assert.equal(second.created, 0);
  assert.equal(state.orders.length, counts.orders);
  assert.equal(state.outbox.length, counts.outbox);
});

test('outbox and audit stay tenant scoped', () => {
  ensureSecondTenant();
  createOrder(OTHER_TENANT, { customerId: 'CUS-G01', reference: `OB-${uniq()}`, origin: '广州', destination: '纽约', items: sampleItems() }, 'erp');
  assert.ok(listOutbox('tenant-acme').every(item => item.tenantId === 'tenant-acme'));
  assert.ok(listOutbox(OTHER_TENANT).every(item => item.tenantId === OTHER_TENANT));
  assert.ok(listAudit(OTHER_TENANT).every(item => item.tenantId === OTHER_TENANT));
});
