import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';

const call = (port, { method = 'GET', path = '/api/categories', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
    let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  req.on('error', reject); if (body) req.write(body); req.end();
});

test('dev-server: weigert vreemde Host (DNS-rebinding) en niet-JSON schrijfacties (CSRF)', async () => {
  const srv = createServer(openDb(':memory:')).listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r)); const port = srv.address().port;
  try {
    assert.equal((await call(port)).status, 200);                                                            // normaal verzoek werkt
    assert.equal((await call(port, { headers: { Host: 'evil.example.com' } })).status, 403);                 // DNS-rebinding
    const post = (ct) => call(port, { method: 'POST', path: '/api/reset', headers: { 'Content-Type': ct }, body: '{"confirm":"WISSEN"}' });
    assert.equal((await post('text/plain')).status, 415);                                                    // CSRF zonder preflight
    assert.equal((await post('application/json')).status, 200);                                              // legitiem gebruik
    assert.equal((await call(port, { method: 'DELETE', path: '/api/goals/1', headers: { Origin: 'https://evil.example.com' } })).status, 403);
  } finally { srv.close(); }
});
