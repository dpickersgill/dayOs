// Phone alerts: turn them on for this phone (a service worker plus a Web Push subscription), off, or send a test.
// On an iPhone this only works once Verdynt/OS is added to the Home Screen and opened from there (an Apple rule).
import { get, post } from './api.js';

export const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
export const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const b64ToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function registration() {
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  return reg;
}

/** 'on', 'off', 'blocked' (the person said no in the browser) or 'unsupported'. */
export async function status() {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

export async function turnOn() {
  if (!supported()) throw new Error(isIos() && !standalone() ? 'On an iPhone, add Verdynt/OS to your Home Screen (Share, Add to Home Screen) and open it from there first.' : 'This browser cannot show alerts.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Alerts were not allowed. You can allow them in this browser\'s site settings.');
  const reg = await registration();
  const { key } = await get('/patrol/alerts/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  const json = sub.toJSON();
  await post('/patrol/alerts/subscribe', { endpoint: json.endpoint, keys: json.keys });
}

export async function turnOff() {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  await post('/patrol/alerts/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

export const test = () => post('/patrol/alerts/test');
