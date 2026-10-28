// Loaded in <head> before the page paints, so there is no flash. Staff screens follow the device's light or dark setting
// until this person picks Light or Dark beside their name (kept on this device; "Same as this device" clears it).
// Printing always uses light colors (app.css).
(function () {
  var mq = null;
  try { mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null; } catch (e) { mq = null; }
  function pick() {
    try { var v = localStorage.getItem('verdynt.theme'); return v === 'light' || v === 'dark' ? v : null; } catch (e) { return null; }
  }
  function apply() {
    var p = pick();
    var dark = p ? p === 'dark' : Boolean(mq && mq.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }
  apply();
  // The device switches between light and dark (at sunset, say): follow it, unless the person picked one.
  if (mq) {
    var follow = function () { if (!pick()) apply(); };
    if (mq.addEventListener) mq.addEventListener('change', follow); else if (mq.addListener) mq.addListener(follow);
  }
}());
