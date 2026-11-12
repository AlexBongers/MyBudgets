import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, propToString } from '../src/notion-api.js';
import { openDb } from '../src/db.js';
import { createApi } from '../src/service.js';

const TOKEN = 'secret_' + 'a'.repeat(40);
const rt = s => [{ plain_text: s }];
const mkPage = (i, over = {}) => ({ id: 'page' + i, properties: {
  Naam: { type: 'title', title: rt('Winkel ' + i) },
  Datum: { type: 'date', date: { start: `2026-11-${String(i).padStart(2, '0')}`, end: null } },
  Bedrag: { type: 'number', number: 12.5 * i },
  Categorie: { type: 'select', select: { name: i % 2 ? 'Boodschappen' : 'Uit eten' } },
  Rekening: { type: 'relation', relation: [{ id: 'acc1' }] },
  Notitie: { type: 'rich_text', rich_text: rt(i === 1 ? 'eerste' : '') },
  Status: { type: 'status', status: { name: 'Betaald' } },
  Totaal: { type: 'formula', formula: { type: 'number', number: 12.5 * i } },
  Wie: { type: 'people', people: [] },
  ...over } });

// nagebootste Notion-server
function fakeNotion({ rateLimitOnce = false, unauthorized = false } = {}) {
  const calls = []; let limited = false;
  const fetch = async (url, init = {}) => {
    const path = url.replace('https://api.notion.com/v1', ''), body = init.body ? JSON.parse(init.body) : {};
    calls.push({ method: init.method, path, body, headers: init.headers });
    const json = (o, status = 200, h = {}) => ({ ok: status < 400, status, statusText: 'x', headers: { get: k => h[k.toLowerCase()] }, json: async () => o });
    if (unauthorized) return json({ message: 'API token is invalid.' }, 401);
    if (rateLimitOnce && !limited && path.endsWith('/query')) { limited = true; return json({ message: 'rate limited' }, 429, { 'retry-after': '0' }); }
    if (path === '/search') return json({ results: [{ id: 'db1', title: rt('Uitgaven'), properties: { a: 1, b: 2 } }, { id: 'db2', title: rt('Budgetten'), properties: {} }], has_more: false });
    if (path === '/databases/db1') return json({ id: 'db1', title: rt('Uitgaven'), properties: { Naam: { type: 'title' }, Datum: { type: 'date' }, Bedrag: { type: 'number' }, Categorie: { type: 'select' }, Rekening: { type: 'relation' }, Notitie: { type: 'rich_text' }, Status: { type: 'status' }, Totaal: { type: 'formula' }, Wie: { type: 'people' } } });
    if (path === '/databases/db1/query') return body.start_cursor ? json({ results: [mkPage(3), mkPage(4)], has_more: false }) : json({ results: [mkPage(1), mkPage(2)], has_more: true, next_cursor: 'c2' });
    if (path === '/databases/db404') return json({ message: 'Could not find database' }, 404);
    if (path === '/pages/acc1') return json({ properties: { Naam: { type: 'title', title: rt('Betaalrekening') } } });
    return json({ message: 'onbekend pad ' + path }, 400);
  };
  return { fetch, calls };
}

test('token-controle', () => {
  assert.throws(() => createClient('kapot'), /integratietoken/);
  assert.doesNotThrow(() => createClient(TOKEN)); assert.doesNotThrow(() => createClient('ntn_' + 'b'.repeat(40)));
});

test('eigenschappen naar tekst: alle types', async () => {
  const P = (t, v) => propToString({ type: t, [t]: v });
  assert.equal(await P('number', 12.5), '12.5'); assert.equal(await P('number', null), '');
  assert.equal(await P('date', { start: '2026-11-12', end: '2026-11-14' }), '2026-11-12 → 2026-11-14');
  assert.equal(await P('multi_select', [{ name: 'a' }, { name: 'b' }]), 'a, b'); assert.equal(await P('checkbox', true), 'Yes');
  assert.equal(await P('formula', { type: 'string', string: 'x' }), 'x'); assert.equal(await P('formula', { type: 'date', date: { start: '2026-01-02' } }), '2026-01-02');
  assert.equal(await P('rollup', { type: 'array', array: [{ type: 'number', number: 3 }, { type: 'number', number: 4 }] }), '3, 4');
  assert.equal(await P('unique_id', { prefix: 'TX', number: 7 }), 'TX-7');
  assert.equal(await propToString({ type: 'relation', relation: [{ id: 'a' }, { id: 'b' }] }, async id => id.toUpperCase()), 'A, B');
  assert.equal(await propToString(undefined), ''); assert.equal(await propToString({ type: 'onbekend' }), '');
});

test('databases lijst + tabel ophalen: paginering, relaties, rate-limit-retry', async () => {
  const f = fakeNotion({ rateLimitOnce: true }); const c = createClient(TOKEN, f.fetch);
  const dbs = await c.listDatabases(); assert.deepEqual(dbs.map(d => d.title), ['Budgetten', 'Uitgaven']);
  const t = await c.databaseToTable('db1');
  assert.equal(t.name, 'Uitgaven'); assert.equal(t.headers[0], 'Naam'); assert.ok(!t.headers.includes('Wie'));  // mensen-kolom weggelaten
  assert.equal(t.rows.length, 4);
  const row = Object.fromEntries(t.headers.map((h, i) => [h, t.rows[0][i]]));
  assert.deepEqual({ n: row.Naam, d: row.Datum, b: row.Bedrag, c: row.Categorie, r: row.Rekening, s: row.Status, f: row.Totaal }, { n: 'Winkel 1', d: '2026-11-01', b: '12.5', c: 'Boodschappen', r: 'Betaalrekening', s: 'Betaald', f: '12.5' });
  assert.equal(f.calls.filter(x => x.path.endsWith('/query')).length, 3);      // 1× 429 + 2 pagina's
  assert.equal(f.calls.filter(x => x.path === '/pages/acc1').length, 1);       // relatietitel gecachet
  assert.equal(f.calls[0].headers['Notion-Version'], '2022-06-28'); assert.match(f.calls[0].headers.Authorization, /^Bearer secret_/);
});

test('foutmeldingen: 401 en 404 zijn begrijpelijk', async () => {
  await assert.rejects(() => createClient(TOKEN, fakeNotion({ unauthorized: true }).fetch).listDatabases(), /401/);
  await assert.rejects(() => createClient(TOKEN, fakeNotion().fetch).databaseToTable('db404'), /Connections/);
  await assert.rejects(() => createClient(TOKEN, async () => { throw Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }); }).listDatabases(), /ENOTFOUND/);
});

test('service: analyseren → voorbeeld → importeren rechtstreeks uit de Notion-API', async () => {
  const f = fakeNotion(), db = openDb(':memory:'), api = createApi(db, { fetch: f.fetch });
  const list = await api('POST', '/api/notion/api/databases', { token: TOKEN }); assert.equal(list.databases.length, 2);
  const src = { apiToken: TOKEN, databaseIds: ['db1'], name: 'Notion' };
  const a = await api('POST', '/api/notion/analyze', src);
  assert.equal(a.tables.length, 1); const t = a.tables[0], g = t.guess;
  assert.equal(g.kind, 'transactions'); assert.equal(g.decimal, '.'); assert.equal(g.fields.date, 'Datum'); assert.equal(g.fields.amount, 'Bedrag'); assert.equal(g.fields.category, 'Categorie'); assert.equal(g.fields.account, 'Rekening');
  const cfg = { fields: g.fields, decimal: g.decimal, dateOrder: g.dateOrder, sign: 'auto' };
  const calls0 = f.calls.length;
  const p = await api('POST', '/api/notion/plan', { ...src, table: t.name, kind: 'transactions', config: cfg });
  assert.equal(p.summary.valid, 4); assert.equal(f.calls.length, calls0, 'voorbeeld gebruikt de cache, geen nieuwe API-verzoeken');
  const r = await api('POST', '/api/notion/import', { ...src, table: t.name, kind: 'transactions', config: cfg });
  assert.equal(r.added, 4);
  const row = db.prepare("SELECT t.amount, c.name cat, a.name acc FROM transactions t JOIN categories c ON c.id=t.category_id JOIN accounts a ON a.id=t.account_id WHERE t.payee='Winkel 2'").get();
  assert.deepEqual({ ...row }, { amount: -2500, cat: 'Uit eten & drinken', acc: 'Betaalrekening' });
  await assert.rejects(() => api('POST', '/api/notion/analyze', { apiToken: TOKEN, databaseIds: [] }), /minimaal één/);
  await assert.rejects(() => api('POST', '/api/notion/api/databases', { token: 'nope' }), /integratietoken/);
  await assert.rejects(() => api('POST', '/api/notion/analyze', { apiToken: TOKEN, databaseIds: ['db404'] }), /Connections/);
});
