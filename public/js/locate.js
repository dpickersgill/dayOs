// The one-time link dispatch texts to a guest who cannot say where they are (/locate/<token>). One big button asks the
// phone for its position and sends it to patrol. It shows nothing about the call except the mountain's name.
import { h, clear } from './ui.js';

const token = location.pathname.split('/').filter(Boolean)[1] || '';
const root = document.getElementById('locate');
const api = `/api/v1/public/locate/${encodeURIComponent(token)}`;
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
main();
