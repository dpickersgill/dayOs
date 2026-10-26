// Patrol > Admin > Report requirements: what each kind of report must hold, set by the patrol director.
//
// Every item has a level (off, recommended, required to approve, required to submit) and can be limited to some cases
// ("only when": serious, transported, under 18, a collision, refused care, staff on duty, rental gear, a lift). A starting
// setup loads a whole set at once, after a preview of what would change. Each save is kept as a version, so a report is
// always judged against the rules it was submitted under. Reviewers and patrollers can read the page; only the patrol
// director (the patrol admin level, owners and managers) can change it.
import { get, put } from '../api.js';
import { h, clear, button, toast, errorBox, loading, dialog, confirmDialog, fmtDateTime, input } from '../ui.js';

const LEVEL_HINT = {
  off: 'Not asked for.',
  recommended: 'Suggested in the report check. Never stops anything.',
  approve: 'Needed before the report is approved. The patroller can still submit; the reviewer sees what is missing.',
  submit: 'Needed before the report can be submitted.',
};

export async function drawRequirements(box) {
  clear(box).append(loading('Loading the report requirements'));
  let d;
  try { d = await get('/patrol/requirements'); } catch (err) { clear(box).append(errorBox(err)); return; }
  const can = Boolean(d.can_admin);
  let saved = JSON.parse(JSON.stringify(d.rules));
  let rules = JSON.parse(JSON.stringify(d.rules));
  let preset = null; // set when a starting setup was loaded and not saved yet
  let type = d.types[0].key;
  const page = h('div', { class: 'stack req-page' });
  clear(box).append(page);

  const dirty = () => JSON.stringify(rules) !== JSON.stringify(saved);
  const typeOf = (k) => d.types.find((t) => t.key === k);
  const levelLabel = (v) => (d.levels.find((l) => l.value === v) || { label: v }).label;
  const counts = (k) => {
    const set = rules[k] || {};
    return { submit: Object.values(set).filter((r) => r.level === 'submit').length, approve: Object.values(set).filter((r) => r.level === 'approve').length };
  };

  function draw() {
    const presetName = (key) => (d.presets.find((p) => p.key === key) || {}).label;
    clear(page).append(
      h('header', { class: 'stack tight' },
        h('h2', null, 'Report requirements'),
        h('p', { class: 'page-note' }, 'What each kind of report must hold before it is submitted or approved. Patrollers see what is required as they write, and a phone with no signal knows the rules too. A report is always checked against the rules in force when it was submitted.'),
        h('p', { class: 'muted small', 'data-status': '' }, d.version.id
          ? `${d.version.preset ? `Started from ${presetName(d.version.preset)}. ` : ''}Last changed ${fmtDateTime(d.version.changed_at)}${d.version.changed_by ? ` by ${d.version.changed_by}` : ''}.`
          : 'Using the mandatory fields set before report requirements. Load a starting setup, or adjust these.'),
        can ? null : h('p', { class: 'warn-note' }, 'Only the patrol director can change these. You can read them.')),
      can ? presetsPanel() : null,
      leaveOption(),
      typePicker(),
      itemsPanel(),
      alwaysPanel(),
      historyPanel(),
      can ? saveBar() : null,
    );
  }

  function presetsPanel() {
    return h('section', { class: 'panel stack', 'data-panel': 'presets' },
      h('h3', null, 'Start from a setup'),
      h('p', { class: 'muted small' }, 'Loads a whole set for every kind of case. You see what would change first, and can adjust anything before saving.'),
      h('div', { class: 'req-presets' }, d.presets.map((p) => h('div', { class: 'req-preset', 'data-preset': p.key },
        h('h4', null, p.label),
        h('p', { class: 'small' }, p.about),
        button('Preview', () => previewPreset(p), { small: true })))));
  }

  async function previewPreset(p) {
    let r;
    try { r = await get(`/patrol/requirements/presets/${p.key}`); } catch (err) { toast(err.message, 'error'); return; }
    const byType = new Map();
    for (const c of r.changes) { if (!byType.has(c.type)) byType.set(c.type, []); byType.get(c.type).push(c); }
    const when = (x) => (x.when && x.when.length ? ` (only when: ${x.when.map((w) => condLabel(x.type || type, w)).join(', ')})` : '');
    let close;
    const body = h('div', { class: 'stack' },
      p.draft ? h('p', { class: 'warn-note' }, 'This setup is a draft built from what insurers commonly ask for. Check it against your own insurer\'s checklist.') : null,
      r.changes.length ? h('p', null, `${r.changes.length} change${r.changes.length === 1 ? '' : 's'} from what you have now:`) : h('p', null, 'This is what you have now. Nothing would change.'),
      ...[...byType].map(([t, list]) => h('details', { class: 'req-diff' }, h('summary', null, `${typeOf(t).label}: ${list.length} change${list.length === 1 ? '' : 's'}`),
        h('ul', { class: 'plain stack tight' }, list.map((c) => h('li', null, h('b', null, c.label), h('span', { class: 'muted' }, ` ${levelLabel(c.from.level)}${when({ ...c.from, type: t })} → `), levelLabel(c.to.level), h('span', { class: 'muted' }, when({ ...c.to, type: t }))))))),
      h('div', { class: 'row' },
        button('Load this setup', () => { rules = JSON.parse(JSON.stringify(r.rules)); preset = p.key; close(); draw(); toast(`${p.label} loaded. Adjust anything, then save.`); }, { kind: 'primary' }),
        button('Cancel', () => close())));
    ({ close } = dialog(`${p.label}: what would change`, body, { wide: true }));
  }

  const condLabel = (t, key) => ((typeOf(t) || typeOf(type)).conditions.find((c) => c.key === key) || { label: key }).label;

  function typePicker() {
    const seg = h('div', { class: 'seg req-types', role: 'group', 'aria-label': 'Kind of case' }, d.types.map((t) => {
      const n = counts(t.key);
      const b = h('button', { type: 'button', 'aria-pressed': String(t.key === type), 'data-type': t.key },
        t.label, h('span', { class: 'req-count' }, n.submit + n.approve ? ` ${n.submit + n.approve}` : ''));
      b.addEventListener('click', () => { type = t.key; draw(); });
      return b;
    }));
    const copy = can ? h('select', { class: 'req-copy', 'aria-label': 'Copy the list from another kind of case', 'data-copy': '' },
      h('option', { value: '' }, 'Copy from…'),
      ...d.types.filter((t) => t.key !== type && typeOf(type).patient_care === t.patient_care).map((t) => h('option', { value: t.key }, t.label))) : null;
    if (copy) {
      copy.addEventListener('change', () => {
        const from = copy.value;
        if (!from) return;
        confirmDialog(`Use the ${typeOf(from).label} list for ${typeOf(type).label} cases?`, 'This replaces what is set for this kind of case. Nothing is saved until you press Save.', 'Copy', () => {
          const ids = new Set(typeOf(type).items.map((i) => i.id));
          rules[type] = Object.fromEntries(Object.entries(rules[from] || {}).filter(([id]) => ids.has(id)).map(([id, r]) => [id, JSON.parse(JSON.stringify(r))]));
          draw();
        });
        copy.value = '';
      });
    }
    return h('section', { class: 'stack tight' }, h('div', { class: 'row between wrap' }, seg, copy),
      h('p', { class: 'muted small' }, typeOf(type).patient_care ? 'Patient care reports: the patient\'s details are asked once for each patient.' : 'No patients on this kind of case: the report, the place, witnesses and sign-off.'));
  }

  function itemsPanel() {
    const t = typeOf(type);
    const set = rules[type] || (rules[type] = {});
    const sections = [];
    for (const item of t.items) {
      let s = sections.find((x) => x.id === item.section);
      if (!s) { s = { id: item.section, title: item.section_title, items: [] }; sections.push(s); }
      s.items.push(item);
    }
    return h('section', { class: 'stack', 'data-panel': 'items' }, sections.map((s) => {
      const required = s.items.filter((i) => set[i.id] && ['submit', 'approve'].includes(set[i.id].level)).length;
      return h('details', { class: 'panel req-section', open: required > 0 || s.id === 'report', 'data-section': s.id },
        h('summary', null, h('span', null, s.title), h('span', { class: 'muted small' }, required ? ` ${required} required` : '')),
        h('div', { class: 'req-rows' }, s.items.map((i) => itemRow(i, set, t))));
    }));
  }

  function itemRow(item, set, t) {
    const r = set[item.id] || { level: 'off' };
    const row = h('div', { class: 'req-row', 'data-item': item.id, 'data-level': r.level });
    if (item.locked === 'always') {
      row.append(h('span', { class: 'req-label' }, item.label), h('span', { class: 'state good' }, 'Always required'));
      return row;
    }
    const sel = h('select', { 'aria-label': `${item.label}: level`, disabled: !can }, d.levels.map((l) => h('option', { value: l.value, selected: l.value === r.level }, l.label)));
    sel.addEventListener('change', () => {
      if (sel.value === 'off') delete set[item.id];
      else set[item.id] = { level: sel.value, ...(r.when && r.when.length ? { when: r.when } : {}) };
      redrawRow(false);
    });
    // "Only when" folds away: a short summary of the chosen conditions, opened with a tap to change them.
    const chosen = (r.when || []).map((w) => (t.conditions.find((c) => c.key === w) || { label: w }).label);
    const whenToggle = h('button', { type: 'button', class: 'req-when-toggle', 'aria-expanded': 'false', hidden: r.level === 'off', disabled: !can && !chosen.length },
      chosen.length ? `Only when: ${chosen.join(', ')}` : (can ? 'Only when…' : ''));
    const whenBox = h('div', { class: 'req-when', hidden: true },
      ...t.conditions.map((c) => {
        const on = Boolean(r.when && r.when.includes(c.key));
        const b = h('button', { type: 'button', class: 'req-cond', 'aria-pressed': String(on), disabled: !can, 'data-cond': c.key }, c.label);
        b.addEventListener('click', () => {
          const cur = set[item.id];
          if (!cur) return;
          const w = new Set(cur.when || []);
          if (w.has(c.key)) w.delete(c.key); else w.add(c.key);
          if (w.size) cur.when = [...w]; else delete cur.when;
          redrawRow(true);
        });
        return b;
      }),
      h('span', { class: 'muted small' }, 'None chosen: every case.'));
    whenToggle.addEventListener('click', () => { const open = whenBox.hidden; whenBox.hidden = !open; whenToggle.setAttribute('aria-expanded', String(open)); });
    row.append(
      h('span', { class: 'req-label' }, item.label, item.when_field ? h('span', { class: 'muted small' }, ' (when it applies)') : null, whenToggle),
      sel, whenBox);
    function redrawRow(keepOpen) {
      const next = itemRow(item, set, t);
      row.replaceWith(next);
      if (keepOpen) { next.querySelector('.req-when').hidden = false; next.querySelector('.req-when-toggle').setAttribute('aria-expanded', 'true'); }
      syncBar();
    }
    row.title = LEVEL_HINT[r.level];
    return row;
  }

  /** "Before the patient leaves": the checklist that opens when an outcome is recorded or hand-off is stamped. */
  function leaveOption() {
    const on = Boolean(rules.options && rules.options.leave);
    const box = h('input', { type: 'checkbox', checked: on, disabled: !can, 'data-option': 'leave' });
    box.addEventListener('change', () => { rules.options = { ...(rules.options || {}), leave: box.checked }; syncBar(); });
    return h('section', { class: 'panel stack tight', 'data-panel': 'leave' },
      h('label', { class: 'check wide' }, box, h('b', null, ' Ask before the patient leaves')),
      h('p', { class: 'muted small' }, 'On patient care cases, when a patroller records an outcome or stamps hand-off or transport, the phone asks for what can only be collected then: contact details, a parent or guardian for anyone under 18, the signed refusal, the rental number and witnesses. Each is done there and then or skipped with a reason, with no signal too. It never holds up care; an item neither done nor skipped holds up the submit, and the reviewer sees every skip.'));
  }

  function alwaysPanel() {
    return h('details', { class: 'panel', 'data-panel': 'always' },
      h('summary', null, 'Always checked, whatever is set here'),
      h('ul', { class: 'stack tight' }, d.always.map((a) => h('li', null, a))));
  }

  function historyPanel() {
    if (!d.history.length) return null;
    return h('details', { class: 'panel', 'data-panel': 'history' },
      h('summary', null, `Changes (${d.history.length})`),
      h('ol', { class: 'stack tight' }, d.history.map((v) => h('li', null, fmtDateTime(v.created_at), ' ', v.changed_by ? `by ${v.changed_by}` : '', v.preset ? ` — started from ${(d.presets.find((p) => p.key === v.preset) || {}).label}` : '', v.note ? h('span', { class: 'muted' }, ` — ${v.note}`) : null))));
  }

  let bar;
  function saveBar() {
    const note = input({ maxlength: 255, placeholder: 'What changed and why (optional)', 'aria-label': 'Note for this change' });
    bar = h('div', { class: 'req-savebar', hidden: !dirty() },
      h('span', { class: 'grow' }, h('b', null, 'Unsaved changes.'), ' Reports submitted from now on use them.'),
      note,
      button('Discard', () => { rules = JSON.parse(JSON.stringify(saved)); preset = null; draw(); }),
      button('Save', async () => {
        try {
          await put('/patrol/requirements', { rules, preset, note: note.value.trim() || null });
          toast('Report requirements saved');
          d = await get('/patrol/requirements');
          saved = JSON.parse(JSON.stringify(d.rules)); rules = JSON.parse(JSON.stringify(d.rules)); preset = null;
          draw();
        } catch (err) { toast(err.message, 'error'); }
      }, { kind: 'primary' }));
    return bar;
  }
  function syncBar() {
    if (bar) bar.hidden = !dirty();
    const seg = page.querySelector('.req-types');
    if (seg) for (const b of seg.querySelectorAll('button')) { const n = counts(b.dataset.type); b.querySelector('.req-count').textContent = n.submit + n.approve ? ` ${n.submit + n.approve}` : ''; }
  }

  draw();
}
