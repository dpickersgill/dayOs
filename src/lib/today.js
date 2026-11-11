'use strict';

// The municipal Today screen's cards (muni release 1). Each municipal app's route file answers GET /<its prefix>/today
// with { cards: [{ title, count, text, href }] }: the title of the card, a number to show large (or null), one plain
// line, and the SPA address it opens ('#/requests?status=open'). The Today screen (public/js/views/dashboard.js) asks
// every app that is on and shows all the cards; an empty list shows nothing. Use todayRoute so every app answers the same way:
//
//   router.get('/today', todayRoute(async (req) => [card({ title: 'Open requests', count: 4, text: '1 is urgent', href: '#/requests?status=open' })]));
//
// Never put a resident's name, phone, email or address on a card: the Today screen is often on a wall screen.

/** One card in the shape the Today screen reads. */
function card({ title, count = null, text = '', href = null }) {
  if (!title) throw new Error('A Today card needs a title');
  return { title: String(title).slice(0, 80), count: count === null || count === undefined ? null : Number(count), text: String(text || '').slice(0, 200), href: href ? String(href) : null };
}

/** A route handler: build(req) returns cards (or card inputs, or nothing); the answer is always { cards: [...] }. */
const todayRoute = (build) => async (req, res) => {
  const out = (await build(req)) || [];
  res.json({ cards: out.filter(Boolean).map(card) });
};

module.exports = { card, todayRoute };
