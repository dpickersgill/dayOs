'use strict';

// Which X-Forwarded-For entries to trust (src/app.js, 2026.11.11). Express walks the list from the right (the nearest
// hop) and stops at the first address it does not trust; that address is req.ip.
//   hop 0: the connection itself, Cloud Run's front end. Always trusted.
//   then:  the Cloud Armor load balancer's own address (TRUST_PROXY_LB_IPS, comma separated, set by scripts/cloud-armor.sh)
//          and Google's front-end ranges (35.191.0.0/16, 130.211.0.0/22). Everything else is the visitor.
// With TRUST_PROXY_LB_IPS unset, the old fixed hop count (TRUST_PROXY_HOPS, default 1) applies.
const GOOGLE_FRONT_ENDS = ['35.191.0.0/16', '130.211.0.0/22'];

const v4 = (ip) => {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(String(ip).trim());
  return m && m.slice(1).every((x) => Number(x) <= 255) ? m.slice(1).reduce((n, x) => n * 256 + Number(x), 0) : null;
};
/** A matcher for addresses and IPv4 ranges ("34.120.10.10", "35.191.0.0/16"); IPv6 by exact address. */
function matcher(list) {
  const rules = list.map((r) => {
    const [ip, bits] = r.split('/');
    const n = v4(ip);
    if (n === null) return (a) => String(a).toLowerCase() === ip.toLowerCase();
    const b = bits === undefined ? 32 : Number(bits);
    const mask = b === 0 ? 0 : (2 ** 32 - 2 ** (32 - b));
    return (a) => { const x = v4(a); return x !== null && ((x & mask) >>> 0) === ((n & mask) >>> 0); };
  });
  return (addr) => rules.some((f) => f(addr));
}

function trustProxy(env = process.env) {
  const lb = String(env.TRUST_PROXY_LB_IPS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!lb.length) return Number(env.TRUST_PROXY_HOPS || 1);
  const known = matcher([...lb, ...GOOGLE_FRONT_ENDS]);
  return (addr, i) => i === 0 || known(addr);
}

module.exports = { trustProxy, matcher, GOOGLE_FRONT_ENDS };
