// A shared terminal a manager enrolled on this computer: { id, tenant, secret, name }, kept in this browser only.
// Crew switch in on it with a PIN (see main.js, showPinSignIn).
const TERM_KEY = 'so.terminal';
export function readTerminal() { try { const t = JSON.parse(localStorage.getItem(TERM_KEY) || 'null'); return t && t.tenant && t.secret ? t : null; } catch (_) { return null; } }
export function saveTerminal(t) { try { if (t) localStorage.setItem(TERM_KEY, JSON.stringify(t)); else localStorage.removeItem(TERM_KEY); } catch (_) { /* private mode */ } }
