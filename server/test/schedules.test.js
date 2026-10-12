import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateEnv } from './helpers.js';

isolateEnv();
const { nextRun, describeCron, listSchedules } = await import('../src/schedules.js');
const { Workflows } = await import('../src/db.js');

const TZ = 'Europe/Madrid';
const at = (expr, iso) => nextRun(expr, TZ, new Date(iso))?.toISOString() ?? null;

test('próxima ejecución, en la zona horaria del nodo', () => {
  assert.equal(at('* * * * *', '2026-10-06T08:00:30Z'), '2026-10-06T08:01:00.000Z');
  assert.equal(at('*/30 * * * * *', '2026-10-06T08:00:10Z'), '2026-10-06T08:00:30.000Z');
  // Viernes 9 de octubre a las 11:00 en Madrid (UTC+2) → lunes 12 a las 8:00 = 06:00Z
  assert.equal(at('0 8 * * 1-5', '2026-10-09T09:00:00Z'), '2026-10-12T06:00:00.000Z');
  assert.equal(at('0 8 * * mon-fri', '2026-10-09T09:00:00Z'), '2026-10-12T06:00:00.000Z', 'con nombres');
  // Día 1 del mes siguiente, ya en horario de invierno (UTC+1)
  assert.equal(at('0 9 1 * *', '2026-10-06T10:00:00Z'), '2026-11-01T08:00:00.000Z');
  assert.equal(at('esto no es cron', '2026-10-06T10:00:00Z'), null);
});

test('próxima ejecución alrededor del cambio de hora (29-3-2026 en Madrid)', () => {
  assert.equal(at('0 0 * * *', '2026-03-28T12:00:00Z'), '2026-03-28T23:00:00.000Z'); // medianoche, aún UTC+1
  assert.equal(at('0 0 * * *', '2026-03-28T23:00:00Z'), '2026-03-29T22:00:00.000Z'); // la siguiente, ya UTC+2
  assert.equal(at('0 12 * * 0', '2026-03-28T12:00:00Z'), '2026-03-29T10:00:00.000Z'); // domingo del cambio
});

test('horario en palabras', () => {
  assert.equal(describeCron('* * * * *'), 'cada minuto');
  assert.equal(describeCron('*/5 * * * *'), 'cada 5 minutos');
  assert.equal(describeCron('0 * * * *'), 'cada hora en punto');
  assert.equal(describeCron('0 8 * * 1-5'), 'de lunes a viernes a las 08:00');
  assert.equal(describeCron('30 9,14 * * *'), 'todos los días a las 09:30 y 14:30');
  assert.equal(describeCron('0 9 1 * *'), 'el día 1 de cada mes a las 09:00');
  assert.equal(describeCron('*/30 * * * * *'), 'cada 30 segundos');
  assert.equal(describeCron('0 0 1 1 *'), null, 'sin forma sencilla: se muestra la expresión');
});

test('lista solo los Cron de workflows activos y marca las expresiones no válidas', () => {
  const cronNode = (id, expr) => ({ id, type: 'cron', name: `Cron ${id}`, x: 0, y: 0, params: { expr, tz: TZ }, exec: {} });
  Workflows.create({ name: 'activo', active: true, graph: { nodes: [cronNode('a', '*/5 * * * *'), cronNode('b', 'mal')], edges: [] } });
  Workflows.create({ name: 'inactivo', active: false, graph: { nodes: [cronNode('c', '* * * * *')], edges: [] } });
  const l = listSchedules(new Date('2026-10-06T08:02:00Z'));
  assert.deepEqual(l.map(s => [s.workflowName, s.nodeId, s.valid, s.descripcion]), [['activo', 'a', true, 'cada 5 minutos'], ['activo', 'b', false, null]]);
  assert.equal(new Date(l[0].proxima).toISOString(), '2026-10-06T08:05:00.000Z');
});
