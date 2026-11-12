// Rechtstreeks lezen uit Notion via de officiële REST-API (dezelfde die notion-sdk-js omhult), zonder dependency.
// Resultaat is hetzelfde tabelformaat als een CSV-export, zodat de bestaande importwizard het kan verwerken.
//   1. maak een integratie op notion.so/my-integrations en kopieer het geheime token,
//   2. deel je database(s) met die integratie (⋯ → Connections), 3. plak het token in MyBudgets.
const BASE = 'https://api.notion.com/v1', VERSION = '2022-06-28';

export class NotionApiError extends Error { constructor(message, status) { super(message); this.status = status; } }

export function createClient(token, fetchFn = globalThis.fetch) {
  if (!/^(secret_|ntn_)[\w-]{20,}$/.test(String(token || '').trim())) throw new NotionApiError('Dat lijkt geen Notion-integratietoken (begint met "secret_" of "ntn_").', 400);
  const headers = { Authorization: `Bearer ${String(token).trim()}`, 'Notion-Version': VERSION, 'Content-Type': 'application/json' };
  async function request(method, path, body, attempt = 0) {
    let res;
    try { res = await fetchFn(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
    catch (e) { throw new NotionApiError('Geen verbinding met Notion: ' + (e.cause?.code || e.message), 502); }
    if (res.status === 429 && attempt < 5) { // rate limit (±3 verzoeken/s): wacht zoals Notion aangeeft
      await new Promise(r => setTimeout(r, Math.min(10000, (Number(res.headers.get('retry-after')) || 1) * 1000))); return request(method, path, body, attempt + 1);
    }
    if (res.status >= 500 && attempt < 2) { await new Promise(r => setTimeout(r, 800 * (attempt + 1))); return request(method, path, body, attempt + 1); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new NotionApiError(res.status === 401 ? 'Notion weigert dit token (401). Controleer of je het volledige geheime token hebt gekopieerd.'
      : res.status === 404 ? 'Notion kan deze database niet vinden. Deel hem met je integratie: ⋯ → Connections.' : `Notion-fout ${res.status}: ${json.message || res.statusText}`, res.status);
    return json;
  }
  async function* paged(method, path, body = {}) {
    let cursor; do { const j = await request(method, path, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }); yield* j.results; cursor = j.has_more ? j.next_cursor : null; } while (cursor);
  }

  const titleOf = db => (db.title || []).map(t => t.plain_text).join('').trim() || '(naamloos)';

  /** Databases die met de integratie gedeeld zijn. */
  async function listDatabases() {
    const out = [];
    for await (const d of paged('POST', '/search', { filter: { property: 'object', value: 'database' } })) out.push({ id: d.id, title: titleOf(d), properties: Object.keys(d.properties || {}).length });
    return out.sort((a, b) => a.title.localeCompare(b.title, 'nl'));
  }

  const pageTitleCache = new Map();
  async function relationTitle(id) {
    if (!pageTitleCache.has(id)) {
      pageTitleCache.set(id, (async () => {
        try { const p = await request('GET', `/pages/${id}`); const t = Object.values(p.properties || {}).find(x => x.type === 'title'); return (t?.title || []).map(x => x.plain_text).join('').trim(); }
        catch { return ''; }
      })());
    }
    return pageTitleCache.get(id);
  }

  /** Eén database → tabel {name, headers, rows}. Relaties worden naar hun paginatitel omgezet. */
  async function databaseToTable(id) {
    const meta = await request('GET', `/databases/${id}`);
    const pages = []; for await (const p of paged('POST', `/databases/${id}/query`)) pages.push(p);
    // kolomvolgorde: titel eerst, dan de rest in de volgorde van Notion
    const names = Object.keys(meta.properties || {});
    const title = names.find(n => meta.properties[n].type === 'title');
    const headers = [...(title ? [title] : []), ...names.filter(n => n !== title && !['people', 'files', 'created_by', 'last_edited_by', 'last_edited_time'].includes(meta.properties[n].type))];
    const rows = [];
    for (const p of pages) {
      const row = [];
      for (const h of headers) row.push(await propToString(p.properties?.[h], relationTitle));
      rows.push(row);
    }
    return { name: titleOf(meta), headers, rows, fromApi: true };
  }
  return { listDatabases, databaseToTable, request };
}

const plain = rt => (rt || []).map(t => t.plain_text).join('').trim();
/** Notion-eigenschap → tekst in een formaat dat de importer al begrijpt (getallen met punt, datums ISO). */
export async function propToString(prop, resolveRelation = async () => '') {
  if (!prop) return '';
  switch (prop.type) {
    case 'title': return plain(prop.title);
    case 'rich_text': return plain(prop.rich_text);
    case 'number': return prop.number == null ? '' : String(prop.number);
    case 'select': return prop.select?.name || '';
    case 'status': return prop.status?.name || '';
    case 'multi_select': return (prop.multi_select || []).map(s => s.name).join(', ');
    case 'date': return prop.date?.start ? (prop.date.end ? `${prop.date.start} → ${prop.date.end}` : prop.date.start) : '';
    case 'checkbox': return prop.checkbox ? 'Yes' : 'No';
    case 'url': case 'email': case 'phone_number': return prop[prop.type] || '';
    case 'created_time': return prop.created_time || '';
    case 'unique_id': return prop.unique_id ? `${prop.unique_id.prefix ? prop.unique_id.prefix + '-' : ''}${prop.unique_id.number}` : '';
    case 'formula': { const f = prop.formula || {}; return f.type === 'date' ? (f.date?.start || '') : f[f.type] == null ? '' : String(f[f.type]); }
    case 'relation': return (await Promise.all((prop.relation || []).map(r => resolveRelation(r.id)))).filter(Boolean).join(', ');
    case 'rollup': {
      const r = prop.rollup || {};
      if (r.type === 'number') return r.number == null ? '' : String(r.number);
      if (r.type === 'date') return r.date?.start || '';
      if (r.type === 'array') return (await Promise.all((r.array || []).map(x => propToString(x, resolveRelation)))).filter(Boolean).join(', ');
      return '';
    }
    default: return '';
  }
}
