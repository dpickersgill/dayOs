import { get, post, patch, put, del, download, openFile, uploadFile } from '../api.js';
import { shareButton } from '../share.js';
import { h, clear, isManager, table, state, input, select, field, button, toast, formDialog, confirmDialog, dialog, val, num, fmtDate, fmtDateTime, empty, fail } from '../ui.js';

const KB = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const VIEWABLE = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/;
const ROLE_NAME = { staff: 'Staff', patrol: 'Patrol', instructor: 'Instructors', counter: 'Counter' };
const MAX_VERSIONS = 10;
const NOT_SEARCHABLE = { needs_ocr: 'Not searchable yet', none: 'No text found in file', unsupported: 'File contents are not searchable', failed: 'Could not read the file' };
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.md,.rtf';

export async function render(root, params = []) {
  const mgr = isManager();
  let categories = []; let roleList = []; let current = 'all'; let query = '';
  // #/documents/d/12 (a shared link): show just that document, with a way back to everything
  let focus = params[0] === 'd' && /^\d+$/.test(params[1] || '') ? Number(params[1]) : null;
  const search = input({ type: 'search', placeholder: 'Search inside documents', 'aria-label': 'Search documents' });
  const chips = h('div', { class: 'fchips', role: 'group', 'aria-label': 'Categories' });
  const body = h('div');
  const scanBar = h('div', { class: 'row scanbar' });
  let ocrAvailable = false;
  const todo = h('div');
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Documents'),
    h('p', { class: 'page-note' }, mgr ? 'Policies, forms, manuals and plans. Choose which roles can see each category.' : 'Files shared with your role.')),
  h('section', { class: 'section' }, h('header', null, h('div', { class: 'row' }, search),
    h('div', { class: 'row' }, mgr ? button('New category', () => editCategory(), { small: true }) : null, button('Add document', () => addDocument(), { small: true, kind: 'primary' }))), chips, todo, scanBar, body));

  async function loadCategories() {
    const r = await get('/documents/categories');
    categories = r.data; roleList = r.roles;
    if (current !== 'all' && !categories.find((c) => c.id === current)) current = 'all';
    drawChips();
  }
  function drawChips() {
    clear(chips);
    const chip = (id, text, count) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(current === id) }, `${text}${count === null ? '' : ` (${count})`}`);
      b.addEventListener('click', () => { current = id; drawChips(); loadDocs().catch(fail); });
      return b;
    };
    chips.append(chip('all', 'All', categories.reduce((n, c) => n + c.documents, 0)), ...categories.map((c) => chip(c.id, c.name, c.documents)));
  }

  async function loadDocs() {
    const params = [];
    if (current !== 'all') params.push(`category_id=${current}`);
    if (query) params.push(`q=${encodeURIComponent(query)}`);
    const { data: all } = await get(`/documents/documents${params.length ? `?${params.join('&')}` : ''}`);
    const data = focus ? all.filter((d) => d.id === focus) : all;
    clear(todo);
    const waiting = data.filter((d) => d.require_ack && !d.accepted_by_me);
    if (waiting.length) todo.append(h('div', { class: 'notice', role: 'status' }, h('strong', null, `${waiting.length} document${waiting.length === 1 ? ' needs' : 's need'} your read and accept: `), waiting.slice(0, 3).map((d) => d.title).join(', '), waiting.length > 3 ? ` and ${waiting.length - 3} more.` : '.'));
    clear(body);
    if (focus) body.append(h('div', { class: 'notice row between', role: 'status' }, h('span', null, data.length ? 'Showing the document that was shared with you.' : 'That document is not here: it was removed, or your role cannot see its category.'), button('Show all documents', () => { focus = null; history.replaceState(null, '', '#/documents'); loadDocs().catch(fail); }, { small: true })));
    const cat = categories.find((c) => c.id === current);
    if (cat) {
      body.append(h('div', { class: 'row' }, h('p', { class: 'muted' }, cat.description || ''),
        mgr ? h('span', { class: 'row grow-end' }, state(cat.roles.length ? `Seen by ${cat.roles.map((r) => ROLE_NAME[r.role] + (r.can_add ? ' (can add)' : '')).join(', ')}` : 'Managers only', cat.roles.length ? 'good' : 'warn'), button('Edit category', () => editCategory(cat), { small: true })) : null));
    }
    if (!data.length) {
      body.append(empty(query ? 'Nothing matches that search.' : categories.length ? 'No documents here yet.' : mgr ? 'Start with a category, such as Safety, HR forms or Manuals, then choose who can see it.' : 'Nothing has been shared with your role yet.'));
      return;
    }
    body.append(table([
      { head: 'Document', cell: (d) => h('span', { class: 'stack tight' }, h('strong', null, d.title), d.require_ack ? (d.accepted_by_me ? state('You accepted this', 'good') : state('Please read and accept', 'warn')) : null, d.description ? h('span', { class: 'muted small' }, d.description) : null,
        d.snippet ? h('span', { class: 'snippet small' }, d.snippet) : null,
        d.file_name && NOT_SEARCHABLE[d.text_status] ? h('span', { class: 'muted small' }, NOT_SEARCHABLE[d.text_status]) : null) },
      { head: 'Category', cell: (d) => d.category },
      { head: 'File', cell: (d) => (d.file_name ? h('span', { class: 'stack tight' }, d.file_name, h('span', { class: 'muted small' }, `${KB(d.size_bytes)}${d.version > 1 ? `, version ${d.version}` : ''}`), d.version_note ? h('span', { class: 'muted small' }, d.version_note) : null) : d.link_url ? 'Web link' : '') },
      { head: 'Updated', cell: (d) => h('span', { class: 'stack tight' }, fmtDate(d.updated_at), d.uploader ? h('span', { class: 'muted small' }, d.uploader) : null) },
      { head: '', cell: (d) => h('span', { class: 'row' }, ...rowActions(d)) },
    ], data));
  }

  function rowActions(d) {
    const out = [];
    if (d.file_name && VIEWABLE.test(d.mime_type)) out.push(button('Open', () => openFile(`/documents/documents/${d.id}/file`), { small: true, kind: 'primary' }));
    if (d.file_name) out.push(button('Download', () => download(`/documents/documents/${d.id}/file?download=1`, d.file_name), { small: true, kind: VIEWABLE.test(d.mime_type) ? null : 'primary' }));
    if (d.file_name && d.version > 1) out.push(button('Versions', () => versionsDialog(d), { small: true }));
    if (d.require_ack && !d.accepted_by_me) out.push(button('I have read this', () => confirmDialog('Read and accept', `Confirm you have read "${d.title}"${d.version > 1 ? ` (version ${d.version})` : ''}. Your name and the time are recorded.`, 'I have read it', async () => { await post(`/documents/documents/${d.id}/accept`); toast('Recorded'); await refresh(); }), { small: true, kind: 'primary' }));
    if (mgr && d.require_ack) out.push(button(`Accepted by ${d.accepted_count}`, () => acceptances(d), { small: true }));
    if (d.link_url) out.push(h('a', { class: 'btn small primary', href: d.link_url, target: '_blank', rel: 'noopener noreferrer' }, 'Open link'));
    out.push(shareButton('document', d.id));
    const cat = categories.find((c) => c.id === d.category_id);
    if (cat && cat.can_add) {
      out.push(button('Edit', () => editDocument(d), { small: true }));
      out.push(button('Delete', () => confirmDialog('Delete document', `Delete "${d.title}"? This removes the file for everyone.`, 'Delete', async () => { await del(`/documents/documents/${d.id}`); toast('Document deleted'); await refresh(); }, { danger: true }), { small: true }));
    }
    return out;
  }

  async function refresh() { await loadCategories(); await loadDocs(); await drawScan(); }

  // ------------------------------------------------------------ making files searchable
  async function drawScan() {
    const [st, space] = await Promise.all([get('/documents/scan-status'), get('/documents/storage')]);
    clear(scanBar); ocrAvailable = st.ocr;
    scanBar.append(h('span', { class: space.percent >= 80 ? 'warn small' : 'muted small' }, `Storage: ${space.used_mb} of ${space.cap_mb} MB used${space.percent >= 80 ? '. Nearly full.' : '.'} `));
    if (!st.total) return;
    const ok = st.counts.indexed || 0;
    scanBar.append(h('span', { class: 'muted small' }, `${ok} of ${st.total} files can be searched by their contents${st.waiting ? `. ${st.waiting} waiting to be scanned.` : '.'}`));
    if (mgr) scanBar.append(h('span', { class: 'row grow-end' },
      st.waiting ? button(`Scan ${st.waiting} waiting`, () => scanAll(false), { small: true, kind: 'primary' }) : null,
      button('Rescan everything', () => confirmDialog('Rescan everything', 'This reads every file again, including pictures of text when text recognition is on. It can take a few minutes for a large library.', 'Rescan', () => scanAll(true)), { small: true })));
  }
  async function scanAll(rescan) {
    let total = 0; let remaining = 1; let first = true;
    const note = h('p', { role: 'status' }, 'Scanning…');
    const dlg = dialog('Scanning documents', [note]);
    try {
      while (remaining > 0) {
        const r = await post('/documents/scan', { limit: 3, rescan: rescan && first });
        first = false; total += r.scanned; remaining = r.remaining;
        note.textContent = `Scanned ${total}${remaining ? `, ${remaining} to go…` : '.'}`;
        if (!r.scanned) break;
      }
      note.textContent = `Done. Scanned ${total} file${total === 1 ? '' : 's'}.`;
    } catch (err) { dlg.close(); throw err; }
    await refresh();
  }
  /** After an upload: read pictures of text right away so the file can be found. */
  async function readNow(id, status) {
    if (status !== 'needs_ocr' || !ocrAvailable) return;
    toast('Reading the text in your file…');
    try { await post(`/documents/documents/${id}/scan`); } catch (err) { fail(err); }
  }

  // ------------------------------------------------------------ add and edit a document
  function addDocument() {
    const writable = categories.filter((c) => c.can_add);
    if (!writable.length) { toast(mgr ? 'Make a category first' : 'Your role cannot add to any category yet', 'error'); return; }
    formDialog('Add a document', h('div', { class: 'form' },
      field('Category', select(writable.map((c) => [c.id, c.name]), current !== 'all' && writable.find((c) => c.id === current) ? current : writable[0].id, { name: 'category_id' })),
      field('Title', input({ name: 'title', required: true, maxlength: 150 })),
      field('Description', input({ name: 'description', maxlength: 500 })),
      field('File', input({ name: 'file', type: 'file', accept: ACCEPT }), 'Up to 10 MB. PDF, Word, Excel, PowerPoint, images, text.'),
      field('Or a web link', input({ name: 'link_url', type: 'url', maxlength: 500, placeholder: 'https://' })),
      h('label', { class: 'check' }, input({ name: 'require_ack', type: 'checkbox' }), 'Ask people to read and accept this')), async (fd) => {
      const file = fd.get('file');
      const hasFile = file && file.size > 0;
      const link = val(fd, 'link_url');
      if (!hasFile && !link) throw new Error('Choose a file or paste a web link');
      if (hasFile && file.size > 10 * 1024 * 1024) throw new Error('Files can be up to 10 MB');
      const { id } = await post('/documents/documents', { category_id: num(fd, 'category_id'), title: val(fd, 'title'), description: val(fd, 'description'), link_url: link, require_ack: fd.get('require_ack') === 'on' });
      if (hasFile) {
        let up;
        try { up = await uploadFile(`/documents/documents/${id}/file`, file); } catch (err) { await del(`/documents/documents/${id}`).catch(() => {}); throw err; }
        await readNow(id, up.text_status);
      }
      toast('Document added');
      await refresh();
    }, { submitText: 'Add document' });
  }

  function editDocument(d) {
    const writable = categories.filter((c) => c.can_add);
    const atLimit = d.file_name && d.version >= MAX_VERSIONS;
    formDialog('Edit document', h('div', { class: 'form' },
      field('Category', select(writable.map((c) => [c.id, c.name]), d.category_id, { name: 'category_id' })),
      field('Title', input({ name: 'title', required: true, maxlength: 150, value: d.title })),
      field('Description', input({ name: 'description', maxlength: 500, value: d.description || '' })),
      field('Web link', input({ name: 'link_url', type: 'url', maxlength: 500, value: d.link_url || '' })),
      field(d.file_name ? 'Replace the file' : 'Attach a file', input({ name: 'file', type: 'file', accept: ACCEPT }),
        !d.file_name ? 'Up to 10 MB' : atLimit ? `Now: ${d.file_name}. This is version ${d.version}, the most we keep. A new file will be added as a new document.` : `Now: ${d.file_name} (version ${d.version} of up to ${MAX_VERSIONS}). The old file is kept as an earlier version.`),
      h('label', { class: 'check' }, input({ name: 'require_ack', type: 'checkbox', checked: d.require_ack }), 'Ask people to read and accept this (a new version asks everyone again)'),
      d.file_name && !atLimit ? field('What changed', input({ name: 'note', maxlength: 200, placeholder: 'Optional, such as "Updated for the 2026 season"' })) : null), async (fd) => {
      const file = fd.get('file');
      const hasFile = file && file.size > 0;
      await patch(`/documents/documents/${d.id}`, { category_id: num(fd, 'category_id'), title: val(fd, 'title'), description: val(fd, 'description'), link_url: val(fd, 'link_url'), require_ack: fd.get('require_ack') === 'on' });
      if (hasFile && atLimit) { newDocumentFrom(d, file, val(fd, 'title') || d.title); await refresh(); return; }
      if (hasFile) {
        const up = await uploadFile(`/documents/documents/${d.id}/file`, file, val(fd, 'note'));
        if (up.version >= up.max_versions) toast(`That is version ${up.version}, the last this document can hold. The next change needs a new document.`);
        await readNow(d.id, up.text_status);
      }
      toast('Saved');
      await refresh();
    });
  }

  /** The document has all 10 versions, so the new file starts a new document in the same category. */
  function newDocumentFrom(d, file, title) {
    confirmDialog('Start a new document?', `"${d.title}" has reached ${MAX_VERSIONS} versions, the most we keep. Create a new document in ${d.category} with this file? The old one stays as it is.`, 'Create new document', async () => {
      const { id } = await post('/documents/documents', { category_id: d.category_id, title: `${title} (new)`, description: d.description });
      let up;
      try { up = await uploadFile(`/documents/documents/${id}/file`, file); } catch (err) { await del(`/documents/documents/${id}`).catch(() => {}); throw err; }
      await readNow(id, up.text_status);
      toast('New document created. You can rename it with Edit.');
      await refresh();
    });
  }

  // ------------------------------------------------------------ who has read it
  async function acceptances(d) {
    const r = await get(`/documents/documents/${d.id}/acceptances`);
    dialog(`Read and accepted: ${d.title}`, [
      h('p', { class: 'muted small' }, `Version ${r.version}. ${r.waiting ? `${r.waiting} of ${r.data.length} still to accept.` : 'Everyone has accepted.'}`),
      table([
        { head: 'Person', cell: (p) => h('span', { class: 'stack tight' }, h('strong', null, p.name), h('span', { class: 'muted small' }, `${p.email}, ${p.role}`)) },
        { head: 'Status', cell: (p) => (p.accepted_at ? state(`Accepted ${fmtDateTime(p.accepted_at)}`, 'good') : state('Not yet', 'warn')) },
      ], r.data)], { wide: true });
  }

  // ------------------------------------------------------------ earlier versions
  async function versionsDialog(d) {
    const v = await get(`/documents/documents/${d.id}/versions`);
    const rows = [v.current, ...v.earlier].filter(Boolean);
    const atLimit = v.current && v.current.version >= v.max;
    const dlg = dialog(`Versions of ${d.title}`, [
      h('p', { class: 'muted small' }, `We keep up to ${v.max} versions. ${atLimit ? 'This document is full, so a new file needs a new document.' : `${v.max - rows.length >= 0 ? v.max - v.current.version : 0} more can be added.`}`),
      table([
        { head: 'Version', cell: (r) => h('span', { class: 'stack tight' }, h('strong', null, `Version ${r.version}`), r.current ? state('Current', 'good') : null) },
        { head: 'File', cell: (r) => h('span', { class: 'stack tight' }, r.file_name, h('span', { class: 'muted small' }, KB(r.size_bytes)), r.note ? h('span', { class: 'muted small' }, r.note) : null) },
        { head: 'Added', cell: (r) => h('span', { class: 'stack tight' }, fmtDateTime(r.uploaded_at), r.uploader ? h('span', { class: 'muted small' }, r.uploader) : null) },
        { head: '', cell: (r) => h('span', { class: 'row' },
          VIEWABLE.test(r.mime_type) ? button('Open', () => openFile(r.current ? `/documents/documents/${d.id}/file` : `/documents/documents/${d.id}/versions/${r.version}/file`), { small: true }) : null,
          button('Download', () => download(r.current ? `/documents/documents/${d.id}/file?download=1` : `/documents/documents/${d.id}/versions/${r.version}/file?download=1`, r.file_name), { small: true }),
          !r.current && v.can_add && !atLimit ? button('Restore', () => confirmDialog('Restore version', `Make version ${r.version} the current file? It will be added as version ${v.current.version + 1}, and nothing is lost.`, 'Restore', async () => { const x = await post(`/documents/documents/${d.id}/versions/${r.version}/restore`); await readNow(d.id, x.text_status); toast('Restored'); dlg.close(); await refresh(); }), { small: true }) : null) },
      ], rows)], { wide: true });
  }

  // ------------------------------------------------------------ categories and who can see them
  function editCategory(cat) {
    const grid = h('div', { class: 'role-grid' }, h('span', { class: 'muted small' }, 'Role'), h('span', { class: 'muted small' }, 'Can see'), h('span', { class: 'muted small' }, 'Can add and remove'));
    const boxes = {};
    for (const role of roleList) {
      const mine = cat && cat.roles.find((r) => r.role === role);
      const see = h('input', { type: 'checkbox', checked: Boolean(mine), 'aria-label': `${ROLE_NAME[role]} can see` });
      const add = h('input', { type: 'checkbox', checked: Boolean(mine && mine.can_add), disabled: !mine, 'aria-label': `${ROLE_NAME[role]} can add and remove` });
      see.addEventListener('change', () => { add.disabled = !see.checked; if (!see.checked) add.checked = false; });
      boxes[role] = { see, add };
      grid.append(h('strong', null, ROLE_NAME[role]), see, add);
    }
    const dlg = formDialog(cat ? `Edit ${cat.name}` : 'New category', h('div', { class: 'form' },
      field('Name', input({ name: 'name', required: true, maxlength: 100, value: cat ? cat.name : '', placeholder: 'Safety, HR forms, Manuals' })),
      field('Description', input({ name: 'description', maxlength: 255, value: cat && cat.description ? cat.description : '' })),
      h('fieldset', { class: 'stack' }, h('legend', null, 'Who can use this category'), grid,
        h('p', { class: 'muted small' }, 'Managers and owners always see everything. A category with no roles ticked is for managers only.'))), async (fd) => {
      const roles = roleList.filter((r) => boxes[r].see.checked).map((r) => ({ role: r, can_add: boxes[r].add.checked }));
      let id = cat && cat.id;
      if (cat) await patch(`/documents/categories/${id}`, { name: val(fd, 'name'), description: val(fd, 'description') });
      else id = (await post('/documents/categories', { name: val(fd, 'name'), description: val(fd, 'description') })).id;
      await put(`/documents/categories/${id}/roles`, { roles });
      toast(cat ? 'Category saved' : 'Category created');
      current = id;
      await refresh();
    }, { submitText: cat ? 'Save category' : 'Create category' });
    if (cat) {
      const del1 = button('Delete category', () => confirmDialog('Delete category', `Delete "${cat.name}"? It must be empty.`, 'Delete', async () => { await del(`/documents/categories/${cat.id}`); dlg.close(); current = 'all'; toast('Category deleted'); await refresh(); }, { danger: true }), { small: true });
      dlg.body.append(del1);
    }
  }

  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query = search.value.trim(); loadDocs().catch(fail); }, 250); });
  await refresh();
}
