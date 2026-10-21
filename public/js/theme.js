// Loaded in <head> before the page paints, so there is no flash: staff screens use the dark Verdynt/OS look unless
// this person chose Light in the account menu (kept on this device). Printing always uses light colours (app.css).
(function () {
  var t = 'dark';
  try { t = localStorage.getItem('verdynt.theme') || 'dark'; } catch (e) { /* storage blocked: dark */ }
  document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
}());
