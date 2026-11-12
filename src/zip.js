// Minimale ZIP-lezer zonder dependencies (methode 0 = opgeslagen, 8 = deflate). Genoeg voor Notion-exports.
import { inflateRawSync } from 'node:zlib';

const MAX_ENTRIES = 20000, MAX_TOTAL = 800 * 1024 * 1024; // bescherming tegen zip-bommen

export function isZip(buf) { return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5); }

/** @returns {{name: string, data: Buffer}[]} bestanden (geen mappen, geen __MACOSX / ._ resten) */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Geen geldig ZIP-bestand (einde van de index niet gevonden).');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw new Error('ZIP64-bestanden worden niet ondersteund. Exporteer uit Notion in kleinere delen.');
  if (count > MAX_ENTRIES) throw new Error('Het ZIP-bestand bevat te veel bestanden.');
  const out = []; let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Beschadigde ZIP-index.');
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32), local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\._/.test(name)) continue;
    total += usize; if (total > MAX_TOTAL) throw new Error('Het uitgepakte ZIP-bestand is te groot.');
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`Beschadigd ZIP-onderdeel: ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`Niet-ondersteunde ZIP-compressie (${method}) in ${name}`);
    out.push({ name, data });
  }
  return out;
}
