/* lab-app.js — the application layer for the lab tools: File menu (new / open / recent / save / save as),
   Preferences, Help (shortcuts, what's new, about), version in the status bar, a modal helper.
   Loads after lab-mod.js and extends window.LabUI with Modal, Prefs, app(). */
(function (global) {
  'use strict';
  const LabUI = global.LabUI; if (!LabUI) return;
  const doc = global.document;
  const el = LabUI.el, keys = LabUI.keys, flash = LabUI.flash;
  const MAC = /Mac|iPhone|iPad/.test(global.navigator && global.navigator.platform || '');
  const kbd = (code, mods) => { const m = (mods || '').split('+').filter(Boolean).map((x) => ({ mod: MAC ? '⌘' : 'Ctrl+', shift: '⇧', alt: MAC ? '⌥' : 'Alt+', ctrl: '⌃', meta: '⌘' })[x] || x).join(''); const k = code.replace(/^Key|^Digit/, '').replace('Comma', ',').replace('Period', '.').replace('Slash', '/').replace('Backslash', '\\').replace('Space', 'Space').replace('Escape', 'Esc').replace(/^Arrow/, ''); return m + k; };

  // ================================================================ Modal
  const Modal = {
    open(o) {
      Modal.close();
      const wrap = el('div', 'lab-modal-wrap'); const box = el('div', 'lab-modal' + (o.wide ? ' lab-modal-wide' : ''));
      const head = el('div', 'lab-modal-head'); head.append(el('b', null, o.title || ''), el('span', 'lab-spacer'));
      const x = el('button', 'lab-qx', '×'); x.type = 'button'; x.addEventListener('click', () => Modal.close()); head.appendChild(x);
      const body = el('div', 'lab-modal-body'); if (typeof o.body === 'string') body.textContent = o.body; else if (o.body) body.appendChild(o.body);
      const foot = el('div', 'lab-modal-foot');
      (o.buttons || [{ title: 'Close' }]).forEach((b) => { const btn = el('button', 'lab-btn' + (b.accent ? ' lab-accent' : '') + (b.danger ? ' lab-danger' : ''), b.title); btn.type = 'button'; btn.addEventListener('click', async () => { let keep = false; if (b.onClick) keep = await b.onClick(); if (!keep) Modal.close(); }); foot.appendChild(btn); });
      box.append(head, body, foot); wrap.appendChild(box); doc.body.appendChild(wrap);
      wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) Modal.close(); });
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); Modal.close(); } };
      doc.addEventListener('keydown', onKey, true);
      Modal._cur = { wrap, onKey }; (box.querySelector('input, select, button.lab-accent') || x).focus();
      return { wrap, box, body, close: Modal.close };
    },
    close() { const c = Modal._cur; if (!c) return; c.wrap.remove(); doc.removeEventListener('keydown', c.onKey, true); Modal._cur = null; },
    get isOpen() { return !!Modal._cur; },
  };

  // ================================================================ Prefs: localStorage lab:<tool>:prefs, a dialog, applied to the shell
  const PREF_DEFAULTS = { fps: 30, side: 'right', scale: 100, autosave: true, confirmDiscard: true, renderDir: '' };
  class Prefs {
    constructor(tool, o) {
      this.tool = tool; this.o = o || {}; this.key = 'lab:' + tool + ':prefs'; this.v = Object.assign({}, PREF_DEFAULTS, this.o.defaults || {});
      try { Object.assign(this.v, JSON.parse(global.localStorage.getItem(this.key) || '{}')); } catch (_) {}
      this._dir = null;
    }
    get(k) { return this.v[k]; }
    set(k, val) { this.v[k] = val; this._save(); this.apply(); }
    _save() { try { global.localStorage.setItem(this.key, JSON.stringify(this.v)); } catch (_) {} }
    reset() { this.v = Object.assign({}, PREF_DEFAULTS, this.o.defaults || {}); this._save(); this.apply(); }
    apply() {
      const sh = this.o.shell; if (!sh) return;
      sh.shell.classList.toggle('lab-side-left', this.v.side === 'left');
      const z = (this.v.scale | 0) || 100; sh.shell.style.zoom = z === 100 ? '' : (z / 100).toFixed(2);
      if (this.o.project) this.o.project.autosaveMs = this.v.autosave ? 1000 : 1e12;
      if (this.o.onApply) this.o.onApply(this.v);
    }
    // the render folder: a directory handle kept in the handles store; finished renders are written there
    async renderDir() {
      if (this._dir) return this._dir; if (!this.v.renderDir) return null;
      const r = await LabUI.LabStore.get('handles', this.tool + ':renderDir'); this._dir = r && r.handle || null; return this._dir;
    }
    async pickRenderDir() {
      if (!global.showDirectoryPicker) { flash('this browser cannot pick folders (Chrome / Edge only)'); return null; }
      try { const h = await global.showDirectoryPicker({ mode: 'readwrite', id: 'lab-render' }); const ok = await LabUI.LabStore.put('handles', this.tool + ':renderDir', { handle: h, name: h.name, t: Date.now() }); if (ok === null) { flash('could not keep the folder'); return null; } this._dir = h; this.set('renderDir', h.name); return h; }
      catch (e) { if (e && e.name !== 'AbortError') console.warn(e); return null; }
    }
    async clearRenderDir() { this._dir = null; await LabUI.LabStore.del('handles', this.tool + ':renderDir'); this.set('renderDir', ''); }
    async saveToRenderDir(blob, name) {
      const dir = await this.renderDir(); if (!dir) return false;
      if (dir.queryPermission && (await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') { if (!dir.requestPermission || (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') return false; }
      const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(blob); await w.close(); flash('saved ' + name + ' → ' + dir.name); return true;
    }
    dialog() {
      const body = el('div', 'lab-prefs');
      const row = (label, widget, hint) => { const r = el('div', 'lab-pref-row'); r.append(el('label', null, label), widget); if (hint) r.appendChild(el('span', 'lab-pref-hint', hint)); body.appendChild(r); return r; };
      const select = (key, opts) => { const w = el('div', 'lab-widget lab-select'); const s = el('select'); opts.forEach(([v, t]) => { const op = el('option', null, t); op.value = String(v); s.appendChild(op); }); s.value = String(this.v[key]); s.addEventListener('change', () => this.set(key, isNaN(+s.value) ? s.value : +s.value)); w.appendChild(s); return w; };
      const check = (key) => { const lab = el('label', 'lab-check'); const i = el('input'); i.type = 'checkbox'; i.checked = !!this.v[key]; i.addEventListener('change', () => this.set(key, i.checked)); lab.append(i, el('span', 'lab-box')); return lab; };
      row('default frame rate', select('fps', [[24, '24'], [25, '25'], [30, '30'], [50, '50'], [60, '60']]), 'new projects start the clock here');
      const dirW = el('div', 'lab-pref-dir'); const dirLab = el('span', 'lab-pref-dirname', this.v.renderDir || 'browser downloads'); const pick = el('button', 'lab-btn', 'Choose…'); pick.type = 'button'; const clr = el('button', 'lab-btn', 'Use downloads'); clr.type = 'button';
      pick.addEventListener('click', async () => { const h = await this.pickRenderDir(); if (h) dirLab.textContent = h.name; }); clr.addEventListener('click', async () => { await this.clearRenderDir(); dirLab.textContent = 'browser downloads'; });
      dirW.append(dirLab, pick, clr); row('render folder', dirW, 'finished renders land here instead of the downloads list');
      row('panel side', select('side', [['right', 'right'], ['left', 'left']]));
      row('interface scale', select('scale', [[90, '90 %'], [100, '100 %'], [110, '110 %'], [125, '125 %'], [150, '150 %']]));
      row('autosave', check('autosave'), 'the current project is kept in the browser as you work');
      row('confirm before discarding', check('confirmDiscard'), 'ask when New or Open would lose unsaved edits');
      if (this.o.extraRows) this.o.extraRows(body, { row, select, check });
      Modal.open({ title: 'Preferences', body, buttons: [{ title: 'Reset to defaults', onClick: () => { this.reset(); Modal.close(); this.dialog(); return true; } }, { title: 'Done', accent: true }] });
    }
  }

  // ================================================================ app(): wires File / Help menus, version cell, what's new, prefs
  // LabUI.app({ shell, pane, project, tool, name:'Channel 3', version:'1.0.0', menus:[...], changelog:[{version, date, notes:[]}], shortcuts:[['drag', 'orbit'], ...], prefs:{...} })
  function app(o) {
    const sh = o.shell, project = o.project, tool = o.tool || (project && project.tool) || 'lab';
    const version = o.version || '0.0.0';
    if (project) { project.o.version = version; project.o.app = project.app = o.name || project.app; }
    const prefs = new Prefs(tool, Object.assign({ shell: sh, project }, o.prefs || {}));
    LabUI.prefs = prefs;
    if (LabUI.Render) LabUI.Render.saveHook = (blob, name) => prefs.saveToRenderDir(blob, name);
    // ---- File
    const confirmDiscard = () => !prefs.get('confirmDiscard') || !project || !project.dirty || global.confirm('Discard unsaved changes?');
    const fileItems = () => {
      const items = [
        { title: 'New project', icon: 'plus', kbd: kbd('KeyN', 'mod+alt'), onClick: () => project && project.newProject({ force: !prefs.get('confirmDiscard') }) },
        { title: 'Open project…', icon: 'folder', kbd: kbd('KeyO', 'mod'), onClick: () => project && project.open() },
      ];
      const rec = state.recents || [];
      items.push({ head: rec.length ? 'Open recent' : 'Open recent · none yet' });
      rec.slice(0, 6).forEach((r) => items.push({ title: r.name + (r.handle ? '' : ' (no handle)'), onClick: () => project && project.openRecent(r) }));
      if (rec.length) items.push({ title: 'Clear recent', onClick: () => project && project.clearRecents() });
      items.push({ sep: true },
        { title: 'Save', icon: 'save', kbd: kbd('KeyS', 'mod'), onClick: () => project && project.save() },
        { title: 'Save as…', kbd: kbd('KeyS', 'mod+shift'), onClick: () => project && project.saveAs() },
        { sep: true });
      (o.fileItems || []).forEach((it) => items.push(it));
      items.push({ sep: true }, { title: 'Preferences…', kbd: kbd('Comma', 'mod'), onClick: () => prefs.dialog() });
      return items;
    };
    const shortcutsSheet = () => {
      const body = el('div', 'lab-sheet');
      const groups = {}; keys.list().forEach((k) => { if (!k.label) return; const g = k.label.split(':')[0].length < 12 && k.label.includes(':') ? k.label.split(':')[0] : 'General'; (groups[g] = groups[g] || []).push([kbd(k.code, k.mods), k.label]); });
      if (o.shortcuts) groups['Mouse / view'] = o.shortcuts;
      Object.keys(groups).sort((a, b) => (a === 'General' ? -1 : b === 'General' ? 1 : a.localeCompare(b))).forEach((g) => { const sec = el('div', 'lab-sheet-group'); sec.appendChild(el('h4', null, g)); groups[g].forEach(([k, l]) => { const r = el('div', 'lab-sheet-row'); r.append(el('kbd', null, k), el('span', null, l)); sec.appendChild(r); }); body.appendChild(sec); });
      Modal.open({ title: 'Keyboard shortcuts', body, wide: true });
    };
    const whatsNew = () => {
      const body = el('div', 'lab-sheet'); const log = o.changelog || [];
      if (!log.length) body.textContent = 'No notes yet.';
      log.forEach((e) => { const sec = el('div', 'lab-sheet-group'); sec.appendChild(el('h4', null, 'v' + e.version + (e.date ? ' · ' + e.date : ''))); const ul = el('ul'); (e.notes || []).forEach((n) => ul.appendChild(el('li', null, n))); sec.appendChild(ul); body.appendChild(sec); });
      Modal.open({ title: "What's new in " + (o.name || tool), body, wide: true });
    };
    const about = () => {
      const body = el('div', 'lab-about');
      body.append(el('div', 'lab-about-name', o.name || tool), el('div', 'lab-about-ver', 'version ' + version + ' · lab-ui ' + LabUI.VERSION), el('div', 'lab-about-txt', o.about || ''), el('div', 'lab-about-txt', 'Humberto Gesser · hubmerto.com'));
      const sys = el('div', 'lab-about-sys'); const gl = (() => { try { const c = doc.createElement('canvas'); const g = c.getContext('webgl2'); const d = g && g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : (g ? 'WebGL2' : 'no WebGL2'); } catch (_) { return ''; } })();
      sys.textContent = [global.navigator.userAgent.replace(/^.*\) /, '').slice(0, 60), gl, 'WebCodecs ' + ('VideoEncoder' in global ? 'yes' : 'no'), 'Web MIDI ' + ('requestMIDIAccess' in global.navigator ? 'yes' : 'no')].filter(Boolean).join(' · ');
      body.appendChild(sys);
      Modal.open({ title: 'About', body, buttons: [{ title: 'Copy details', onClick: () => { try { global.navigator.clipboard.writeText((o.name || tool) + ' ' + version + ' · lab-ui ' + LabUI.VERSION + ' · ' + sys.textContent); flash('copied'); } catch (_) {} return true; } }, { title: 'Close', accent: true }] });
    };
    const helpItems = () => [
      { title: 'Keyboard shortcuts', kbd: kbd('Slash', 'mod'), onClick: shortcutsSheet },
      { title: "What's new", onClick: whatsNew },
      { sep: true },
      { title: 'About ' + (o.name || tool), onClick: about },
    ];
    const state = { recents: [] };
    const build = () => {
      const menus = (o.menus || []).map((m) => (m.title === 'File' ? { title: 'File', items: fileItems().concat(m.items && m.items.length ? [{ sep: true }].concat(m.items) : []) } : m));
      if (!menus.some((m) => m.title === 'File')) menus.unshift({ title: 'File', items: fileItems() });
      menus.push({ title: 'Help', items: helpItems() });
      sh.setMenus(menus);
    };
    build();
    const refreshRecents = async () => { if (!project) return; state.recents = await project.recents(); build(); };
    if (project) { project.on('recents', refreshRecents); project.on('save', refreshRecents); refreshRecents(); }
    // ---- keys
    keys.bind('KeyN', 'mod+alt', () => project && project.newProject({ force: !prefs.get('confirmDiscard') }), { label: 'New project' });
    keys.bind('KeyS', 'mod+shift', () => project && project.saveAs(), { label: 'Save project as' });
    keys.bind('Comma', 'mod', () => prefs.dialog(), { label: 'Preferences' });
    keys.bind('Slash', 'mod', () => shortcutsSheet(), { label: 'Keyboard shortcuts' });
    // ---- version cell in the status strip
    if (sh.status) { const cell = el('span', 'lab-cell lab-version', 'v' + version); cell.title = (o.name || tool) + ' ' + version + ' · lab-ui ' + LabUI.VERSION + ' · click for what\'s new'; cell.style.cursor = 'pointer'; cell.addEventListener('click', whatsNew); sh.status.appendChild(cell); }
    // ---- what's new on the first run of a new version
    const seenKey = 'lab:' + tool + ':seen'; let seen = ''; try { seen = global.localStorage.getItem(seenKey) || ''; } catch (_) {}
    if (seen && seen !== version && (o.changelog || []).length) setTimeout(whatsNew, 600);
    try { global.localStorage.setItem(seenKey, version); } catch (_) {}
    prefs.apply();
    const api = { prefs, version, shortcutsSheet, whatsNew, about, rebuildMenus: build, confirmDiscard, Modal };
    LabUI.appApi = api; return api;
  }

  LabUI.Modal = Modal; LabUI.Prefs = Prefs; LabUI.app = app; LabUI.kbd = kbd;
})(typeof window !== 'undefined' ? window : globalThis);
