// The one-time link dispatch texts to a guest who cannot say where they are (/locate/<token>). One big button asks the
// phone for its position and sends it to patrol. It shows nothing about the call except the mountain's name.
import { h, clear } from './ui.js';

// A phone that takes the period after the link in a text (Text HELP: "...your location: <link>.") still works.
const token = (location.pathname.split('/').filter(Boolean)[1] || '').replace(/(\.|%2E)+$/i, '');
const root = document.getElementById('locate');
// /help-locate/<token>: the shared Text HELP number's link, for a guest whose text did not say which ski area (help/shared).
const shared = location.pathname.startsWith('/help-locate/');
const api = `/api/v1/public/${shared ? 'help-locate' : 'locate'}/${encodeURIComponent(token)}`;
const note = (text) => h('p', { class: 'muted' }, text);

async function main() {
  document.getElementById('locate-loading')?.remove();
  let page;
  try {
    const res = await fetch(api);
    if (!res.ok) throw new Error('gone');
    page = await res.json();
  } catch (_) {
    root.append(h('h1', null, 'This link has expired'), note('Call ski patrol and tell them where you are, or call 911 in an emergency.'));
    return;
  }
  if (shared) { sharedPage(page); return; }
  document.title = `${page.mountain} ski patrol: share your location`;
  const go = h('button', { type: 'button', class: 'btn primary big locate-go' }, 'Send my location to patrol');
  const msg = h('div', { role: 'status', 'aria-live': 'polite' });
  root.append(h('h1', null, `${page.mountain} ski patrol`),
    h('p', null, 'Patrol is trying to find you. Press the button, then choose Allow when your phone asks to share your location.'),
    go, msg, note('Only your position is sent, once. Keep your phone with you and stay where you are if it is safe.'));
  go.addEventListener('click', () => {
    clear(msg);
    if (!navigator.geolocation) { msg.append(h('p', { class: 'error-box', role: 'alert' }, 'This phone cannot share its location here. Tell patrol where you are by phone.')); return; }
    go.disabled = true; go.textContent = 'Finding where you are…';
    navigator.geolocation.getCurrentPosition(async (p) => {
      try {
        const res = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not send');
        clear(root).append(h('div', { class: 'help-done' }, h('h1', null, 'Patrol has your location'),
          h('p', null, `Accurate to about ${Math.round(p.coords.accuracy)} meters. Stay where you are if it is safe, keep warm, and keep your phone on.`),
          h('p', null, 'If you move, or things get worse, call patrol or 911.')));
      } catch (err) { go.disabled = false; go.textContent = 'Try again'; msg.append(h('p', { class: 'error-box', role: 'alert' }, `${err.message}. Tell patrol where you are by phone.`)); }
    }, (err) => {
      go.disabled = false; go.textContent = 'Try again';
      msg.append(h('p', { class: 'error-box', role: 'alert' }, err.code === 1
        ? 'Location was not allowed. Press Try again and choose Allow, or turn on Location for your browser in Settings.'
        : 'Your phone could not find its position. Move into the open if you can and press Try again.'));
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}
// The shared link: the position finds the ski area (the nearest within 50 km). In Spanish when the guest texted in Spanish.
const SW = {
  en: { title: 'Ski patrol', sub: 'Press the button, then choose Allow when your phone asks to share your location. It tells patrol which ski area you are at.',
    go: 'Send my location to ski patrol', finding: 'Finding where you are…', again: 'Try again', done: (m) => `${m} ski patrol has your location`,
    doneSub: 'Stay where you are if it is safe, keep warm, and keep your phone on. If it is life threatening, call 911.',
    asked: 'Two ski areas are close to you. We texted you a short list: reply with the number of yours.',
    nomatch: 'We could not tell which ski area you are at from your location. Reply to our text with the ski area\'s name, or call 911.',
    noGeo: 'This phone cannot share its location here. Reply to our text with the ski area\'s name.', denied: 'Location was not allowed. Press Try again and choose Allow, or reply to our text with the ski area\'s name.',
    lost: 'Your phone could not find its position. Reply to our text with the ski area\'s name.', e911: 'If it is life threatening, call 911.' },
  es: { title: 'Patrulla de esquí', sub: 'Toque el botón y elija Permitir cuando su teléfono pida compartir su ubicación. Así la patrulla sabe en qué estación de esquí está.',
    go: 'Enviar mi ubicación a la patrulla', finding: 'Buscando dónde está…', again: 'Intentar otra vez', done: (m) => `La patrulla de esquí de ${m} tiene su ubicación`,
    doneSub: 'Quédese donde está si es seguro, manténgase abrigado y deje su teléfono encendido. Si su vida corre peligro, llame al 911.',
    asked: 'Hay dos estaciones de esquí cerca. Le enviamos una lista corta por mensaje: responda con el número de la suya.',
    nomatch: 'No pudimos saber en qué estación de esquí está por su ubicación. Responda a nuestro mensaje con el nombre de la estación, o llame al 911.',
    noGeo: 'Este teléfono no puede compartir su ubicación aquí. Responda a nuestro mensaje con el nombre de la estación.', denied: 'No se permitió la ubicación. Toque Intentar otra vez y elija Permitir, o responda con el nombre de la estación.',
    lost: 'Su teléfono no pudo encontrar su posición. Responda a nuestro mensaje con el nombre de la estación.', e911: 'Si su vida corre peligro, llame al 911.' },
};
function sharedPage(page) {
  const T = SW[page.lang === 'es' ? 'es' : 'en'];
  document.documentElement.lang = page.lang === 'es' ? 'es' : 'en';
  document.title = T.title;
  if (page.state === 'matched' && page.mountain) document.title = `${page.mountain}: ${T.title}`;
  const go = h('button', { type: 'button', class: 'btn primary big locate-go' }, T.go);
  const msg = h('div', { role: 'status', 'aria-live': 'polite' });
  root.append(h('h1', null, page.mountain ? `${page.mountain}: ${T.title}` : T.title), h('p', null, T.sub), go, msg, h('p', null, h('a', { class: 'btn', href: 'tel:911' }, 'Call 911'), ' ', T.e911));
  go.addEventListener('click', () => {
    clear(msg);
    if (!navigator.geolocation) { msg.append(h('p', { class: 'error-box', role: 'alert' }, T.noGeo)); return; }
    go.disabled = true; go.textContent = T.finding;
    navigator.geolocation.getCurrentPosition(async (p) => {
      try {
        const res = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || 'Could not send');
        if (!out.matched && out.asked) { clear(root).append(h('div', { class: 'help-done' }, h('h1', null, T.asked), h('p', null, T.e911), h('a', { class: 'btn', href: 'tel:911' }, 'Call 911'))); return; }
        if (!out.matched) { go.disabled = false; go.textContent = T.again; msg.append(h('p', { class: 'error-box', role: 'alert' }, T.nomatch)); return; }
        clear(root).append(h('div', { class: 'help-done' }, h('h1', null, T.done(out.mountain)), h('p', null, T.doneSub), h('a', { class: 'btn', href: 'tel:911' }, 'Call 911')));
      } catch (err) { go.disabled = false; go.textContent = T.again; msg.append(h('p', { class: 'error-box', role: 'alert' }, `${err.message}. ${T.e911}`)); }
    }, (err) => {
      go.disabled = false; go.textContent = T.again;
      msg.append(h('p', { class: 'error-box', role: 'alert' }, err.code === 1 ? T.denied : T.lost));
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}

main();
