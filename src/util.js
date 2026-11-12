// Kleine gedeelde helpers (datums als 'YYYY-MM-DD' / 'YYYY-MM', bedragen in centen).

export const MONTH_RE = /^\d{4}-\d{2}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Fout met HTTP-status; de dispatcher en IPC geven status + bericht door aan de interface. */
export const httpErr = (status, message) => Object.assign(new Error(message), { status });

/** 'YYYY-MM' + n maanden (n mag negatief zijn). */
export const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
/** Aantal dagen in 'YYYY-MM'. */
export const daysIn = m => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
/** 'YYYY-MM-DD' → dagnummer (dagen sinds 1970), handig voor verschillen. */
export const dayNum = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
/** 'YYYY-MM-DD' + n dagen. */
export const addDays = (d, n) => new Date((dayNum(d) + Math.round(n)) * 864e5).toISOString().slice(0, 10);
export const today = () => new Date().toISOString().slice(0, 10);

/** IBAN zonder spaties, in hoofdletters. */
export const normIban = s => String(s || '').replace(/\s+/g, '').toUpperCase();

/** Centen → "€ 1.234" (vanaf €100 zonder centen), voor teksten zoals inzichten. */
export const eurText = c => (c / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: Math.abs(c) >= 10000 ? 0 : 2 });

/** Getal binnen [min, max], of de standaardwaarde als het geen getal is. */
export const clampInt = (v, min, max, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
