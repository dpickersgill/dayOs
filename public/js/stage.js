// On staging (the test copy of DAY/OS), a band across the top of every page says so, and the tab title starts with
// "Staging", so nobody mistakes it for the live site. Production shows nothing.
fetch('/version', { cache: 'no-store' }).then((r) => r.json()).then((v) => {
  if (!v || v.stage !== 'staging' || document.getElementById('stage-band')) return;
  const band = document.createElement('div');
  band.id = 'stage-band';
  band.setAttribute('role', 'note');
  band.textContent = `Staging ${v.version}: test copy. Payments are in test mode and email goes to the team, not to guests.`;
  band.style.cssText = 'position:sticky;top:0;z-index:9999;background:#ffd23f;color:#3a2a00;font:600 14px/1.4 system-ui,sans-serif;text-align:center;padding:6px 12px';
  document.body.prepend(band);
  if (!/^Staging/.test(document.title)) document.title = `Staging · ${document.title}`;
}).catch(() => {});
