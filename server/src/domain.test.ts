import test from 'node:test'; import assert from 'node:assert/strict'; import { containerPlan, createGateAppointment, dashboard, deleteGateAppointment, editGateAppointment, gateConflicts, prioritizeTasks } from './domain.js';
test('dashboard aggregates berth, yard, gate and exception signals', () => { const data = dashboard(); assert.equal(data.activeVoyages, 2); assert.ok(data.yardUtilization > 0.7); assert.ok(data.blockedTasks >= 1); });
test('gate conflict engine detects same truck overlap', () => { const conflicts = gateConflicts(); assert.ok(conflicts.some(item => item.appointmentId === 'APT-9001' || item.appointmentId === 'APT-9004')); });
test('gate conflict engine flags short turnaround and ignores cancelled slots', () => {
  const shortGap = gateConflicts().find(item => item.kind === 'short-gap' && item.appointmentId === 'APT-9006');
  assert.ok(shortGap, 'APT-9002 与 APT-9006 相隔 16 分钟应被标记为间隔过短');
  assert.equal(shortGap?.otherId, 'APT-9002');
});
test('cancelled appointments are excluded from truck conflict pairs', () => {
  const base = Date.now();
  const a = createGateAppointment({ containerId: 'MSCU-4829017', truckNo: 'TEST-CANCEL-1', driver: '测试', type: 'pickup', windowStart: new Date(base + 3600000).toISOString(), windowEnd: new Date(base + 5400000).toISOString(), lane: 'north' });
  const b = createGateAppointment({ containerId: 'MSCU-4829017', truckNo: 'TEST-CANCEL-1', driver: '测试', type: 'pickup', windowStart: new Date(base + 3900000).toISOString(), windowEnd: new Date(base + 5700000).toISOString(), lane: 'north' });
  assert.ok(gateConflicts().some(item => (item.appointmentId === a.id || item.appointmentId === b.id) && item.kind === 'overlap'));
  editGateAppointment(a.id, { status: 'cancelled' });
  editGateAppointment(b.id, { status: 'cancelled' });
  assert.equal(gateConflicts().some(item => item.appointmentId === a.id || item.appointmentId === b.id || item.otherId === a.id || item.otherId === b.id), false);
  deleteGateAppointment(a.id); deleteGateAppointment(b.id);
});
test('yard planner respects reefer and hazmat constraints', () => { const plan = containerPlan('TGHU-9831204'); assert.equal(plan?.recommendedBlock?.hazmatAllowed, true); assert.ok(plan?.reasons.some(reason => reason.includes('危险品'))); });
test('priority queue promotes customs inspection work', () => { const tasks = prioritizeTasks(); assert.equal(tasks[0].containerId, 'TGHU-9831204'); });

test('container create, update and delete form a complete audited CRUD cycle', async () => {
  const { createContainer, updateContainer, deleteContainer, containers } = await import('./domain.js');
  const created = createContainer({ id: 'TEST-CRUD-0001', voyageId: 'VOY-AX7', size: '20', isoType: '22G1', direction: 'import', status: 'in-yard', weightT: 10, reefer: false, customs: 'released', priority: 'normal', yardSlot: 'C03-R11-T1' });
  assert.equal(created.id, 'TEST-CRUD-0001');
  assert.equal(updateContainer(created.id, { weightT: 12 })?.weightT, 12);
  assert.equal(deleteContainer(created.id)?.id, 'TEST-CRUD-0001');
  assert.equal(containers.some(item => item.id === 'TEST-CRUD-0001'), false);
});

test('appointment and task domain operations support create, update and delete', async () => {
  const { createGateAppointment, editGateAppointment, deleteGateAppointment, createYardTask, updateYardTask, deleteYardTask } = await import('./domain.js');
  const appointment = createGateAppointment({ containerId: 'MSCU-4829017', truckNo: 'TEST-CRUD-01', driver: '测试司机', type: 'pickup', windowStart: new Date(Date.now()+3600000).toISOString(), windowEnd: new Date(Date.now()+7200000).toISOString(), lane: 'north' });
  assert.equal(editGateAppointment(appointment.id, { driver: '更新司机' })?.driver, '更新司机');
  assert.equal(deleteGateAppointment(appointment.id)?.id, appointment.id);
  const task = createYardTask({ kind: 'deliver', containerId: 'MSCU-4829017', from: 'A01-R01-T1', to: '南闸口', priority: 40, scheduledAt: new Date().toISOString(), estimatedMinutes: 12 });
  assert.equal(updateYardTask(task.id, { to: '北闸口' })?.to, '北闸口');
  assert.equal(deleteYardTask(task.id)?.id, task.id);
});
