/* lab-mod.js — keyframes, modulation matrix, bake, MIDI learn and the command palette for the lab tools.
   Loads after lab-render.js and extends window.LabUI with Timeline, ModMatrix, Bake, MidiLearn, Palette.

   Composition (Pane.effective): keyed value replaces the base; modulators add on top, scaled to the control's
   range and clamped; a bypassed folder's identity wins last. Nothing here writes into Binding values or history:
   keys and routes are their own state (saved in the project), modulation is read at draw time. */
(function (global) {
  'use strict';
  const LabUI = global.LabUI; if (!LabUI) return;
  const doc = global.document;
  const el = LabUI.el, keys = LabUI.keys, flash = LabUI.flash;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const uid = () => Math.random().toString(36).slice(2, 8);
  const cloneV = (v) => (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return () => this.off(ev, fn); }
    off(ev, fn) { if (this._h[ev]) this._h[ev] = this._h[ev].filter((f) => f !== fn); }
    emit(ev, a) { (this._h[ev] || []).slice().forEach((f) => { try { f(a); } catch (e) { console.error(e); } }); }
  }
  const sliderOf = (pane, path) => { const b = pane.byPath(path); return (b && b.view === 'slider' && typeof b.opts.min === 'number' && typeof b.opts.max === 'number') ? b : null; };
  const rangeOf = (b) => (b.opts.max - b.opts.min) || 1;
  const INTERPS = ['hold', 'linear', 'ease', 'bezier'];
  const BEZIER_DEFAULT = [0.42, 0, 0.58, 1];
  const GRAPH_H = 96;
  const BEZIER_PRESETS = { 'ease in': [0.42, 0, 1, 1], 'ease out': [0, 0, 0.58, 1], 'ease in out': [0.42, 0, 0.58, 1], 'snap': [0.9, 0, 0.1, 1], 'overshoot': [0.34, 1.56, 0.64, 1] };
  // y for x on a CSS-style cubic bezier (0,0)-(x1,y1)-(x2,y2)-(1,1), bisection on x
  function bezierY(k, h) { const [x1, y1, x2, y2] = h || BEZIER_DEFAULT; const bx = (t) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t; const by = (t) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t; let lo = 0, hi = 1, t = k; for (let i = 0; i < 24; i++) { t = (lo + hi) / 2; if (bx(t) < k) lo = t; else hi = t; } return by(t); }

  // ================================================================ Timeline: keys per path + the strip
  class Timeline extends Emitter {
    // new Timeline(pane, { clock, host: shell.view, project, tool })
    constructor(pane, o) {
      super(); o = o || {};
      this.pane = pane; this.clock = o.clock; this.o = o; this.keys = {}; this.armed = false; this.sel = new Set(); this.collapsed = false;
      this.graph = false; this.graphMode = 'value'; this.graphPath = null;   // graph editor: one lane drawn as a curve, with draggable keys and bezier handles
      pane.timeline = this; if (this.clock && !pane.clock) pane.clock = this.clock;
      this._marks = new Map();
      if (o.host) this._mount(o.host);
      if (o.project && o.project.register) o.project.register('keys', { get: () => this.getState(), set: (s) => this.setState(s) });
      if (this.clock) { this.clock.on('time', () => this._drawHead()); this.clock.on('range', () => this.render()); this.clock.on('markers', () => this.render()); }
      // arm: an edit at the playhead writes a key
      pane.on('change', (ev) => { if (!this.armed || !ev || ev.last === false || ev.programmatic || !ev.target || !ev.target.path) return; const b = ev.target; if (b.view !== 'slider' && b.view !== 'checkbox') return; this.setKey(b.path, this.clock ? this.clock.t : 0, b.value, undefined, { history: false }); });
      if (o.keys !== false) {
        keys.bind('KeyK', '', () => this.keyFocused(), { label: 'Key the focused control' });
        keys.bind('KeyK', 'shift', () => this.keyFolder(), { label: 'Key the focused folder' });
        keys.bind('Comma', 'alt', () => this.jump(-1), { label: 'Previous key' });
        keys.bind('Period', 'alt', () => this.jump(1), { label: 'Next key' });
        keys.bind('F6', '', () => this.setInterp('hold'), { label: 'Keys: hold' });
        keys.bind('F7', '', () => this.setInterp('linear'), { label: 'Keys: linear' });
        keys.bind('F8', '', () => this.setInterp('ease'), { label: 'Keys: ease' });
        keys.bind('F9', '', () => this.easyEase(), { label: 'Keys: easy ease' });
        keys.bind('F9', 'shift', () => this.setHandles(BEZIER_PRESETS['ease in']), { label: 'Keys: ease in' });
        keys.bind('F9', 'alt', () => this.setHandles(BEZIER_PRESETS['ease out']), { label: 'Keys: ease out' });
        keys.bind('F9', 'mod', () => this.editHandles(), { label: 'Keys: bezier handles' });
        keys.bind('KeyR', 'alt', () => this.setRoving(), { label: 'Keys: toggle roving (time floats)' });
        keys.bind('KeyG', 'alt', () => this.toggleGraph(), { label: 'Graph editor' });
        keys.bind('KeyA', 'shift', () => this.setArmed(!this.armed), { label: 'Arm keyframe recording' });
      }
    }
    // ---- data
    keysFor(path) { return this.keys[path] || []; }
    has(root) { const pre = root + '.'; return Object.keys(this.keys).some((p) => p.startsWith(pre) && this.keys[p].length); }
    get paths() { return Object.keys(this.keys).filter((p) => this.keys[p].length); }
    valueAt(path, t) {
      const ks = this.keys[path]; if (!ks || !ks.length) return undefined;
      if (t <= ks[0].t) return ks[0].v; const last = ks[ks.length - 1]; if (t >= last.t) return last.v;
      let i = 1; while (i < ks.length && ks[i].t < t) i++;
      const a = ks[i - 1], b = ks[i]; if (typeof a.v !== 'number' || typeof b.v !== 'number') return a.v;
      const interp = b.i || 'linear';
      if (interp === 'hold') return a.v;
      let k = (t - a.t) / Math.max(1e-9, b.t - a.t); if (interp === 'ease') k = k * k * (3 - 2 * k); else if (interp === 'bezier') k = bezierY(k, b.h);
      return a.v + (b.v - a.v) * k;
    }
    // overrides for one root at time t: {key: value}
    resolve(root, t) { const out = {}; const pre = root + '.'; Object.keys(this.keys).forEach((p) => { if (p.startsWith(pre) && this.keys[p].length) out[p.slice(pre.length)] = this.valueAt(p, t); }); return out; }
    onKey(path, t) { const fps = this.clock ? this.clock.fps : 30; return this.keysFor(path).some((k) => Math.abs(k.t - t) < 0.5 / fps); }
    _snap(t) { const fps = this.clock ? this.clock.fps : 30; return Math.max(0, Math.round(t * fps) / fps); }
    _record(path, before, after, label) {
      const h = this.pane.history; if (!h) return;
      h.push({ kind: 'keys', label, before: { ['keys.' + path]: cloneV(before) }, after: { ['keys.' + path]: cloneV(after) }, paths: ['keys.' + path] });
    }
    setKey(path, t, v, interp, o) {
      o = o || {}; t = this._snap(t);
      const before = cloneV(this.keys[path] || []); const ks = (this.keys[path] = this.keys[path] || []);
      const fps = this.clock ? this.clock.fps : 30; let k = ks.find((x) => Math.abs(x.t - t) < 0.5 / fps);
      if (k) { k.v = v; if (interp) k.i = interp; } else { k = { t, v, i: interp || (ks.length ? (ks[ks.length - 1].i || 'linear') : 'linear') }; ks.push(k); ks.sort((a, b) => a.t - b.t); }
      if (o.history !== false) this._record(path, before, ks, 'Key ' + (this.pane.pathLabel(path) || path) + ' @ ' + (this.clock ? this.clock.timecode(t) : t.toFixed(2)));
      this._changed(); return k;
    }
    removeKey(path, t, o) {
      o = o || {}; const ks = this.keys[path]; if (!ks) return false; const fps = this.clock ? this.clock.fps : 30;
      const before = cloneV(ks); const n = ks.length; this.keys[path] = ks.filter((x) => Math.abs(x.t - t) >= 0.5 / fps);
      if (this.keys[path].length === n) return false;
      if (o.history !== false) this._record(path, before, this.keys[path], 'Remove key ' + (this.pane.pathLabel(path) || path));
      this._changed(); return true;
    }
    // undo / redo and project load land here
    setKeysFor(path, arr) { this.keys[path] = (arr || []).map((k) => { const o = { t: +k.t, v: k.v, i: k.i || 'linear' }; if (k.h) o.h = k.h.slice(0, 4).map(Number); if (k.r) o.r = true; return o; }).sort((a, b) => a.t - b.t); this._changed(); }
    // roving keys float in time so the value moves at constant speed through them: a run of roving keys between two fixed
    // keys is spaced by cumulative |Δv| (evenly when the values do not change); the first and last key of a lane are always fixed
    _rove(path) {
      const ks = this.keys[path]; if (!ks || ks.length < 3) return false; let moved = false;
      for (let a = 0; a < ks.length - 1;) {
        let b = a + 1; while (b < ks.length - 1 && ks[b].r) b++;
        if (b > a + 1) {
          const num = (x) => typeof x.v === 'number'; let total = 0; const d = [];
          for (let i = a + 1; i <= b; i++) { const di = (num(ks[i]) && num(ks[i - 1])) ? Math.abs(ks[i].v - ks[i - 1].v) : 1; d.push(di); total += di; }
          let cum = 0; for (let i = a + 1; i < b; i++) { cum += d[i - a - 1]; const f = total > 0 ? cum / total : (i - a) / (b - a); const t = this._snap(ks[a].t + (ks[b].t - ks[a].t) * f); if (t !== ks[i].t) { ks[i].t = t; moved = true; } }
        }
        a = b;
      }
      return moved;
    }
    _roveAll() { this.paths.forEach((p) => this._rove(p)); }
    setRoving(v) {
      const sel = this._selKeys(); if (!sel.length) { flash('select keys first'); return; }
      const on = v == null ? !sel.every(({ k }) => k.r) : !!v;
      const before = {}; sel.forEach(({ p }) => { if (!before[p]) before[p] = cloneV(this.keys[p]); });
      sel.forEach(({ p, k }) => { const ks = this.keys[p]; if (on && (k === ks[0] || k === ks[ks.length - 1])) return; if (on) k.r = true; else delete k.r; });
      Object.keys(before).forEach((p) => { this._rove(p); this._record(p, before[p], this.keys[p], on ? 'Roving keys' : 'Fixed keys'); });
      this.sel = new Set(sel.map(({ p, k }) => p + '@' + k.t)); flash(on ? 'roving: time follows the values' : 'keys fixed in time'); this._changed();
    }
    clear(path) { if (path) delete this.keys[path]; else this.keys = {}; this.sel.clear(); this._changed(); }
    getState() { const out = {}; this.paths.forEach((p) => { out[p] = this.keys[p].map((k) => { const o = { t: k.t, v: k.v, i: k.i }; if (k.h) o.h = k.h.slice(); if (k.r) o.r = true; return o; }); }); return { keys: out, armed: this.armed, collapsed: this.collapsed, graph: this.graph, graphMode: this.graphMode, graphPath: this.graphPath }; }
    setState(s) { if (!s) return; this.keys = {}; Object.keys(s.keys || {}).forEach((p) => this.setKeysFor(p, s.keys[p])); this.armed = !!s.armed; this.collapsed = !!s.collapsed; this.graph = !!s.graph; this.graphMode = s.graphMode === 'speed' ? 'speed' : 'value'; this.graphPath = s.graphPath || null; this._changed(); }
    _changed() { this._roveAll(); this.render(); this._markRows(); this.emit('change'); if (this.o.project) this.o.project.touch(); }
    // ---- actions
    keyFocused() {
      const b = this.pane.focusedBinding(); if (!b || !b.path || (b.view !== 'slider' && b.view !== 'checkbox')) { flash('focus a slider or checkbox, then K'); return null; }
      const t = this.clock ? this.clock.t : 0; const k = this.setKey(b.path, t, b.value); flash('key · ' + (this.pane.pathLabel(b.path) || b.path) + ' @ ' + (this.clock ? this.clock.timecode(t) : t)); return k;
    }
    keyFolder() {
      const f = this.pane.focusedFolder(); if (!f) { flash('focus a folder first'); return 0; }
      const t = this.clock ? this.clock.t : 0; let n = 0;
      const h = this.pane.history; if (h) h.beginTx && h.beginTx('Key ' + f.title);
      f.bindings().forEach((b) => { if (b.path && (b.view === 'slider' || b.view === 'checkbox') && !b.hidden) { this.setKey(b.path, t, b.value, undefined, { history: false }); n++; } });
      if (h && h.cancelTx) h.cancelTx();
      flash('keyed ' + n + ' in ' + f.title); return n;
    }
    jump(dir) {
      if (!this.clock) return; const t = this.clock.t; let best = null; const fps = this.clock.fps;
      this.paths.forEach((p) => this.keys[p].forEach((k) => { const d = (k.t - t) * dir; if (d > 0.5 / fps && (best == null || d < best)) best = d; }));
      if (best == null) { flash(dir > 0 ? 'no next key' : 'no previous key'); return; }
      this.clock.pause(); this.clock.seek(t + best * dir);
    }
    _selKeys() { const out = []; this.sel.forEach((id) => { const [p, ts] = id.split('@'); const k = (this.keys[p] || []).find((x) => String(x.t) === ts); if (k) out.push({ p, k }); }); return out; }
    setInterp(i) { if (!this.sel.size) { flash('select keys first'); return; } this._selKeys().forEach(({ k }) => { k.i = i; if (i === 'bezier' && !k.h) k.h = BEZIER_DEFAULT.slice(); }); flash('keys: ' + i); this._changed(); }
    easyEase() { if (!this.sel.size) { flash('select keys first (F9 = easy ease)'); return; } this.setInterp('ease'); }
    // bezier handles of the selected keys: [x1, y1, x2, y2] in segment space (the key is the end of its segment)
    setHandles(h) { const sel = this._selKeys(); if (!sel.length) { flash('select keys first'); return; } sel.forEach(({ k }) => { k.i = 'bezier'; k.h = h.slice(0, 4).map(Number); }); this._changed(); }
    toggleGraph(on) { this.graph = on == null ? !this.graph : !!on; if (this.graph && !this.graphPath) this.graphPath = this._graphTarget(); flash(this.graph ? 'graph editor · drag keys and handles · alt+G to close' : 'graph editor off'); this._changed(); }
    _graphTarget() { const sel = this._selKeys(); if (sel.length) return sel[0].p; const b = this.pane.focusedBinding && this.pane.focusedBinding(); if (b && b.path && this.keys[b.path] && this.keys[b.path].length) return b.path; return this.paths[0] || null; }
    editHandles() {
      const sel = this._selKeys(); if (!sel.length) { flash('select a key first'); return; }
      const k = sel[0].k; const h = (k.h || BEZIER_DEFAULT).slice(); k.i = 'bezier'; k.h = h;
      let box = this.el.querySelector('.lab-strip-bez'); if (box) box.remove();
      box = el('div', 'lab-strip-bez'); const inputs = ['x1', 'y1', 'x2', 'y2'].map((n, i) => { const inp = el('input'); inp.type = 'number'; inp.step = '0.01'; inp.value = String(+h[i].toFixed(3)); inp.title = n; inp.addEventListener('change', () => { h[i] = clamp(+inp.value || 0, i % 2 ? -2 : 0, i % 2 ? 3 : 1); this.setHandles(h); }); inp.addEventListener('keydown', (e) => e.stopPropagation()); return inp; });
      const presets = el('div', 'lab-widget lab-select'); const ps = el('select'); const op0 = el('option', null, 'preset…'); op0.value = ''; ps.appendChild(op0); Object.keys(BEZIER_PRESETS).forEach((n) => { const op = el('option', null, n); op.value = n; ps.appendChild(op); }); presets.appendChild(ps);
      ps.addEventListener('change', () => { const v = BEZIER_PRESETS[ps.value]; if (!v) return; v.forEach((x, i) => { h[i] = x; inputs[i].value = String(x); }); this.setHandles(h); ps.value = ''; });
      const close = el('button', 'lab-qx', '×'); close.type = 'button'; close.addEventListener('click', () => box.remove());
      box.append(el('span', 'lab-tlabel', 'handles'), ...inputs, presets, close); this.el.appendChild(box); this._changed();
    }
    deleteSelected() { if (!this.sel.size) return; const by = {}; this.sel.forEach((id) => { const [p, ts] = id.split('@'); (by[p] = by[p] || []).push(+ts); }); Object.keys(by).forEach((p) => { const before = cloneV(this.keys[p]); this.keys[p] = this.keys[p].filter((k) => !by[p].includes(k.t)); this._record(p, before, this.keys[p], 'Remove keys'); }); this.sel.clear(); this._changed(); }
    // record paths as keys while the clock plays (a camera move): getter() returns {key: value} for the root, keys land every 1/rate s, then thin
    recordPaths(paths, o) {
      o = o || {}; if (this._recPaths) { this.stopRecord(); return false; }
      if (!this.clock) return false; const rate = o.rate || 4; let last = -1e9;
      const off = this.clock.on('time', () => { const t = this.clock.t; if (!this.clock.playing || t - last < 1 / rate - 1e-6) return; last = t; const vals = o.getter ? o.getter() : null; paths.forEach((p) => { const root = p.slice(0, p.indexOf('.')), key = p.slice(root.length + 1); let v = vals ? vals[key] : undefined; if (v == null) { const b = this.pane.byPath(p); v = b ? b.value : undefined; } if (typeof v === 'number') this.setKey(p, t, +v.toFixed(5), 'linear', { history: false }); }); });
      this._recPaths = { paths, off, eps: o.eps != null ? o.eps : 0.002 }; this.clock.play(); flash('recording keys · press again to stop'); this.emit('record', { on: true, paths }); return true;
    }
    stopRecord() {
      const r = this._recPaths; if (!r) return; this._recPaths = null; r.off(); this.clock.pause();
      // thin: drop keys that linear interpolation of their neighbours already gives
      r.paths.forEach((p) => { const ks = this.keys[p]; if (!ks || ks.length < 3) return; const keep = [ks[0]]; for (let i = 1; i < ks.length - 1; i++) { const a = keep[keep.length - 1], b = ks[i + 1], k = ks[i]; const lin = a.v + (b.v - a.v) * ((k.t - a.t) / Math.max(1e-9, b.t - a.t)); if (Math.abs(lin - k.v) > r.eps) keep.push(k); } keep.push(ks[ks.length - 1]); this.keys[p] = keep; });
      flash('take: ' + r.paths.reduce((n, p) => n + (this.keys[p] || []).length, 0) + ' keys'); this._changed(); this.emit('record', { on: false, paths: r.paths });
    }
    get recording() { return !!this._recPaths; }
    setArmed(v) { this.armed = !!v; if (this._armBtn) this._armBtn.classList.toggle('on', this.armed); flash(this.armed ? 'arm: edits write keys' : 'arm off'); this.emit('arm', { armed: this.armed }); }
    // ---- row markers: filled diamond on a key, hollow while interpolating, none when unkeyed
    _markRows() {
      const live = new Set(this.paths);
      this.pane.bindings().forEach((b) => { const p = b.path; if (!p) return; let m = this._marks.get(b); if (live.has(p)) { if (!m) { m = el('i', 'lab-keymark', '◆'); m.title = 'keyed · alt+, / alt+. to jump'; (b._in || b._label).appendChild(m); this._marks.set(b, m); } } else if (m) { m.remove(); this._marks.delete(b); } });
      this._drawHead();
    }
    // ---- strip
    _mount(host) {
      const s = el('div', 'lab-strip'); this.el = s;
      const head = el('div', 'lab-strip-head');
      const btn = (cls, text, tip) => { const b = el('button', 'lab-tool lab-tp-txt ' + cls, text); b.type = 'button'; if (tip) LabUI.bindTip(b, tip); return b; };
      const title = el('span', 'lab-tlabel', 'keys');
      const arm = btn('lab-strip-arm', 'arm', 'Arm: edits at the playhead write keys (shift+A)'); this._armBtn = arm; arm.addEventListener('click', () => this.setArmed(!this.armed));
      const k = btn('', 'K', 'Key the focused control (K)'); k.addEventListener('click', () => this.keyFocused());
      const prev = btn('', '‹', 'Previous key (alt+,)'), next = btn('', '›', 'Next key (alt+.)'); prev.addEventListener('click', () => this.jump(-1)); next.addEventListener('click', () => this.jump(1));
      const sel = el('div', 'lab-widget lab-select lab-strip-interp'); const se = el('select'); const op0 = el('option', null, 'interp'); op0.value = ''; op0.disabled = true; se.appendChild(op0); INTERPS.forEach((i) => { const op = el('option', null, i); op.value = i; se.appendChild(op); }); sel.appendChild(se); se.addEventListener('change', () => { if (se.value) this.setInterp(se.value); }); sel.title = 'interpolation of the selected keys (F6 hold · F7 linear · F8 ease · F9 easy ease)'; this._interpSel = se;
      const del = btn('', '×', 'Delete selected keys (Delete)'); del.addEventListener('click', () => this.deleteSelected());
      const count = el('span', 'lab-strip-count'); this._count = count;
      const fold = btn('lab-strip-fold', '▾', 'Collapse the strip'); fold.addEventListener('click', () => { this.collapsed = !this.collapsed; this.render(); });
      const graph = btn('lab-strip-graph', 'graph', 'Graph editor: the selected lane as a curve (alt+G)'); this._graphBtn = graph; graph.addEventListener('click', () => this.toggleGraph());
      const speed = btn('lab-strip-speed', 'speed', 'Graph shows speed (value per second) instead of value'); this._speedBtn = speed; speed.addEventListener('click', () => { this.graphMode = this.graphMode === 'speed' ? 'value' : 'speed'; this.render(); });
      const sep = () => el('i', 'lab-tsep');
      const gNav = el('div', 'lab-tgroup'); gNav.append(k, prev, next);
      const gGraph = el('div', 'lab-tgroup'); gGraph.append(graph, speed);
      head.append(title, arm, sep(), gNav, sep(), sel, del, sep(), gGraph, el('span', 'lab-spacer'), count, fold);
      const lanes = el('div', 'lab-strip-lanes'); this._lanes = lanes;
      const headLine = el('div', 'lab-strip-headline'); this._headLine = headLine;
      lanes.appendChild(headLine);
      s.append(head, lanes); host.appendChild(s); host.classList.add('lab-has-strip');
      // drags on diamonds, scrub on the ruler, box select on empty lane space
      let drag = null;
      lanes.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return; const d = e.target.closest('.lab-key');
        const track = e.target.closest('.lab-lane-track'); if (!track) return;
        const r = track.getBoundingClientRect(); const frac = (x) => clamp((x - r.left) / Math.max(1, r.width), 0, 1);
        if (d) {
          const id = d.dataset.id; if (!e.shiftKey && !this.sel.has(id)) this.sel.clear(); if (e.shiftKey && this.sel.has(id)) this.sel.delete(id); else this.sel.add(id);
          drag = { kind: 'move', x0: e.clientX, r, moved: false, start: [...this.sel].map((sid) => { const [p, ts] = sid.split('@'); return { p, t: +ts }; }) };
          lanes.setPointerCapture(e.pointerId); this.render(); e.preventDefault(); return;
        }
        if (!e.shiftKey) { this.sel.clear(); if (this.clock) this.clock.seek(frac(e.clientX) * this.clock.duration); drag = { kind: 'scrub', r }; lanes.setPointerCapture(e.pointerId); this.render(); }
      });
      lanes.addEventListener('pointermove', (e) => {
        if (!drag) return; const r = drag.r; const frac = (x) => clamp((x - r.left) / Math.max(1, r.width), 0, 1);
        if (drag.kind === 'scrub') { if (this.clock) this.clock.seek(frac(e.clientX) * this.clock.duration); return; }
        const dt = (e.clientX - drag.x0) / Math.max(1, r.width) * (this.clock ? this.clock.duration : 10); if (!drag.moved && Math.abs(e.clientX - drag.x0) < 3) return; drag.moved = true;
        if (!drag.before) { drag.before = {}; drag.start.forEach((s) => { if (!drag.before[s.p]) drag.before[s.p] = cloneV(this.keys[s.p]); }); }
        const next = new Set();
        const tol = 6 / Math.max(1, r.width) * (this.clock ? this.clock.duration : 10);
        drag.start.forEach((s) => { const ks = this.keys[s.p]; const k = ks.find((x) => x._drag === s.t || (x._drag == null && x.t === s.t)); if (!k) return; k._drag = s.t; delete k.r; const t = clamp(s.t + dt, 0, this.clock ? this.clock.duration : 1e9); k.t = this.clock ? this.clock.snap(t, tol) : this._snap(t); next.add(s.p + '@' + k.t); });
        Object.keys(drag.before).forEach((p) => this.keys[p].sort((a, b) => a.t - b.t));
        this.sel = next; this.render();
      });
      const up = () => { if (!drag) return; const d = drag; drag = null; if (d.kind === 'move' && d.moved && d.before) { Object.keys(d.before).forEach((p) => { this.keys[p].forEach((k) => { delete k._drag; }); this._record(p, d.before[p], this.keys[p], 'Move keys'); }); this._changed(); } };
      lanes.addEventListener('pointerup', up); lanes.addEventListener('pointercancel', up);
      lanes.addEventListener('dblclick', (e) => {
        const d = e.target.closest('.lab-key'); const track = e.target.closest('.lab-lane-track'); if (!track) return;
        if (d) { if (this.clock) { this.clock.pause(); this.clock.seek(+d.dataset.t); } return; }
        const lane = track.closest('.lab-lane'); const p = lane && lane.dataset.path; if (!p) return;
        const r = track.getBoundingClientRect(); const t = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1) * (this.clock ? this.clock.duration : 10);
        const b = this.pane.byPath(p); const v = this.valueAt(p, t); this.setKey(p, t, v != null ? v : (b ? b.value : 0));
      });
      lanes.addEventListener('contextmenu', (e) => {
        const d = e.target.closest('.lab-key'); if (!d) return; e.preventDefault(); const id = d.dataset.id; if (!this.sel.has(id)) { this.sel.clear(); this.sel.add(id); this.render(); }
        const roving = this._selKeys().every(({ k }) => k.r);
        LabUI.contextMenu(e.clientX, e.clientY, INTERPS.map((i) => ({ title: i, onClick: () => this.setInterp(i) })).concat([{ title: 'Easy ease (F9)', onClick: () => this.easyEase() }, { title: 'Bezier handles…', onClick: () => this.editHandles() }, { sep: true }, { title: (roving ? '✓ ' : '') + 'Roving (time floats)', onClick: () => this.setRoving(!roving) }, { title: 'Show in graph editor', onClick: () => { this.graphPath = id.split('@')[0]; this.toggleGraph(true); } }, { sep: true }, { title: 'Delete', danger: true, onClick: () => this.deleteSelected() }]));
      });
      doc.addEventListener('keydown', (e) => { if (!this.sel.size || (e.key !== 'Delete' && e.key !== 'Backspace')) return; const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; e.preventDefault(); this.deleteSelected(); });
      this.render();
    }
    render() {
      if (!this.el) return;
      const paths = this.paths; const s = this.el;
      s.classList.toggle('lab-strip-empty', !paths.length); s.classList.toggle('collapsed', this.collapsed);
      this._armBtn.classList.toggle('on', this.armed);
      if (this._count) this._count.textContent = paths.length ? paths.reduce((n, p) => n + this.keys[p].length, 0) + ' keys' : '';
      const lanes = this._lanes; [...lanes.querySelectorAll('.lab-lane')].forEach((n) => n.remove());
      const dur = Math.max(1e-6, this.clock ? this.clock.duration : 10);
      const beat = this.clock && this.clock.beat; const grid = (beat && beat.bpm) ? beat : null;
      paths.forEach((p) => {
        const lane = el('div', 'lab-lane'); lane.dataset.path = p;
        lane.appendChild(el('span', 'lab-lane-label', this.pane.pathLabel(p) || p));
        const track = el('div', 'lab-lane-track');
        if (this.clock && this.clock.rangeSet) { const r = el('i', 'lab-lane-range'); r.style.left = (this.clock.in / dur * 100) + '%'; r.style.width = ((this.clock.out - this.clock.in) / dur * 100) + '%'; track.appendChild(r); }
        if (grid) { const per = 60 / grid.bpm; for (let t = (grid.t0 || 0) % per; t < dur; t += per) { const g = el('i', 'lab-lane-beat'); g.style.left = (t / dur * 100) + '%'; track.appendChild(g); } }
        if (this.clock) this.clock.markers.forEach((m) => { const g = el('i', 'lab-lane-mark'); g.style.left = (m.t / dur * 100) + '%'; g.title = m.name; track.appendChild(g); });
        this.keys[p].forEach((k) => { const d = el('b', 'lab-key lab-key-' + (k.i || 'linear') + (k.r ? ' rove' : '')); d.style.left = (k.t / dur * 100) + '%'; d.dataset.id = p + '@' + k.t; d.dataset.t = String(k.t); d.title = (this.clock ? this.clock.timecode(k.t) : k.t.toFixed(2)) + ' · ' + (typeof k.v === 'number' ? +k.v.toFixed(4) : k.v) + ' · ' + (k.i || 'linear') + (k.r ? ' · roving' : ''); if (this.sel.has(d.dataset.id)) d.classList.add('sel'); track.appendChild(d); });
        lane.appendChild(track); lanes.appendChild(lane);
      });
      if (this._graphBtn) this._graphBtn.classList.toggle('on', this.graph); if (this._speedBtn) { this._speedBtn.classList.toggle('on', this.graphMode === 'speed'); this._speedBtn.style.display = this.graph ? '' : 'none'; }
      if (this._interpSel) { const sk = this._selKeys(); const same = sk.length && sk.every(({ k }) => (k.i || 'linear') === (sk[0].k.i || 'linear')) ? (sk[0].k.i || 'linear') : ''; this._interpSel.value = same; }
      let old = lanes.querySelector('.lab-gedit'); let gh = 0;
      if (this.graph && paths.length) { if (!this.graphPath || !this.keys[this.graphPath] || !this.keys[this.graphPath].length) this.graphPath = this._graphTarget(); if (old && old.dataset.path !== this.graphPath) { old.remove(); old = null; } const g = this._renderGraph(this.graphPath, dur, old); if (g) { if (!g.isConnected) lanes.appendChild(g); gh = GRAPH_H; } else if (old) old.remove(); }
      else if (old) old.remove();
      const h = paths.length ? Math.min(5, paths.length) * 16 + 22 + gh : 22;
      const host = s.parentElement; if (host) host.style.setProperty('--lab-strip', (this.collapsed ? 22 : h) + 'px');
      this._drawHead();
    }
    // ---- graph editor: the lane's curve over the clock, keys as dots (drag: time and value), bezier handles of selected keys (drag: shape)
    _renderGraph(p, dur, wrap) {
      const ks = this.keys[p]; const b = sliderOf(this.pane, p); if (!ks || !ks.length || !b) return null;
      const W = Math.max(100, ((this._lanes && this._lanes.clientWidth) || 1096) - 96), H = GRAPH_H - 4, PAD = 6; const min = b.opts.min, max = b.opts.max; this._graphW = W;   // 1 svg unit = 1 px, so dots stay round
      const speed = this.graphMode === 'speed';
      const vAt = (t) => +this.valueAt(p, t); const eps = 1 / (this.clock ? this.clock.fps : 30);
      const sAt = (t) => (vAt(Math.min(dur, t + eps / 2)) - vAt(Math.max(0, t - eps / 2))) / eps;
      let lo = min, hi = max; const pts = [];
      const N = 240; for (let i = 0; i <= N; i++) { const t = dur * i / N; pts.push([t, speed ? sAt(t) : vAt(t)]); }
      if (speed) { lo = Math.min(0, ...pts.map((q) => q[1])); hi = Math.max(0, ...pts.map((q) => q[1])); if (hi - lo < 1e-9) { lo -= 1; hi += 1; } const m = (hi - lo) * 0.08; lo -= m; hi += m; }
      const X = (t) => (t / dur * W).toFixed(1), Y = (v) => (PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD)).toFixed(1);
      const fresh = !wrap; if (fresh) { wrap = el('div', 'lab-gedit'); wrap.append(el('div', 'lab-gedit-label'), doc.createElementNS('http://www.w3.org/2000/svg', 'svg')); }
      wrap.dataset.path = p;
      const label = wrap.firstChild; label.textContent = ''; label.append(el('b', null, this.pane.pathLabel(p) || p), el('span', null, speed ? 'speed /s' : (+hi.toFixed(3)) + ' … ' + (+lo.toFixed(3))));
      const NS = 'http://www.w3.org/2000/svg'; const svg = wrap.lastChild; svg.textContent = ''; svg.setAttribute('viewBox', '0 0 ' + W + ' ' + GRAPH_H); svg.setAttribute('preserveAspectRatio', 'none');
      const mk = (tag, attrs, cls) => { const n = doc.createElementNS(NS, tag); Object.keys(attrs).forEach((k) => n.setAttribute(k, attrs[k])); if (cls) n.setAttribute('class', cls); svg.appendChild(n); return n; };
      if (this.clock && this.clock.rangeSet) mk('rect', { x: X(this.clock.in), y: 0, width: (Math.max(0, this.clock.out - this.clock.in) / dur * W).toFixed(1), height: GRAPH_H }, 'lab-g-range');
      if (this.clock) this.clock.markers.forEach((m) => mk('line', { x1: X(m.t), x2: X(m.t), y1: 0, y2: GRAPH_H }, 'lab-g-mark'));
      if (speed) mk('line', { x1: 0, x2: W, y1: Y(0), y2: Y(0) }, 'lab-g-zero');
      mk('polyline', { points: pts.map((q) => X(q[0]) + ',' + Y(q[1])).join(' ') }, 'lab-g-curve');
      if (!speed) ks.forEach((k, i) => {
        const id = p + '@' + k.t; const selOn = this.sel.has(id);
        if (selOn && k.i === 'bezier' && i > 0 && typeof k.v === 'number' && typeof ks[i - 1].v === 'number') {
          const a = ks[i - 1], h = k.h || BEZIER_DEFAULT; const dt = k.t - a.t, dv = k.v - a.v;
          const h1 = [a.t + h[0] * dt, a.v + h[1] * dv], h2 = [a.t + h[2] * dt, a.v + h[3] * dv];
          mk('line', { x1: X(a.t), y1: Y(a.v), x2: X(h1[0]), y2: Y(h1[1]) }, 'lab-g-hline'); mk('line', { x1: X(k.t), y1: Y(k.v), x2: X(h2[0]), y2: Y(h2[1]) }, 'lab-g-hline');
          const c1 = mk('circle', { cx: X(h1[0]), cy: Y(h1[1]), r: 5 }, 'lab-g-handle'); c1.dataset.id = id; c1.dataset.h = '0';
          const c2 = mk('circle', { cx: X(h2[0]), cy: Y(h2[1]), r: 5 }, 'lab-g-handle'); c2.dataset.id = id; c2.dataset.h = '2';
        }
        const c = mk('circle', { cx: X(k.t), cy: Y(typeof k.v === 'number' ? k.v : min), r: 5 }, 'lab-g-key' + (selOn ? ' sel' : '') + (k.r ? ' rove' : '')); c.dataset.id = id; c.dataset.t = String(k.t);
        const tt = doc.createElementNS(NS, 'title'); tt.textContent = (this.clock ? this.clock.timecode(k.t) : k.t.toFixed(2)) + ' · ' + (typeof k.v === 'number' ? +k.v.toFixed(4) : k.v) + ' · ' + (k.i || 'linear'); c.appendChild(tt);
      });
      const headLine = mk('line', { x1: X(this.clock ? this.clock.t : 0), x2: X(this.clock ? this.clock.t : 0), y1: 0, y2: GRAPH_H }, 'lab-g-head'); this._graphHead = headLine; this._graphDur = dur;
      // geometry of this paint, read by the drag handlers (the wrap and its listeners outlive repaints)
      wrap._g = { p, ks, b, lo, hi, min, max, dur, speed, vAt };
      if (!fresh) return wrap;
      // drags: a key dot moves in time (snapped) and value (clamped to the slider range); a handle reshapes the segment in [0..1] x, free y
      let drag = null;
      const pos = (e) => { const g = wrap._g; const r = wrap.lastChild.getBoundingClientRect(); return { t: clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1) * g.dur, v: g.lo + (1 - clamp((e.clientY - r.top) / Math.max(1, r.height), -0.5, 1.5)) * (g.hi - g.lo), tol: 6 / Math.max(1, r.width) * g.dur }; };
      const paint = () => this._renderGraph(wrap._g.p, wrap._g.dur, wrap);
      wrap.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return; const g = wrap._g; const key = e.target.closest('.lab-g-key'), hd = e.target.closest('.lab-g-handle');
        if (key) { const id = key.dataset.id; if (!e.shiftKey && !this.sel.has(id)) this.sel.clear(); this.sel.add(id); const [, ts] = id.split('@'); const k = g.ks.find((x) => String(x.t) === ts); drag = { kind: 'key', k, t0: k.t, v0: k.v, p0: pos(e), moved: false, before: cloneV(g.ks) }; wrap.setPointerCapture(e.pointerId); e.preventDefault(); paint(); return; }
        if (hd) { const [, ts] = hd.dataset.id.split('@'); const i = g.ks.findIndex((x) => String(x.t) === ts); if (i <= 0) return; drag = { kind: 'handle', k: g.ks[i], a: g.ks[i - 1], hi: +hd.dataset.h, before: cloneV(g.ks) }; wrap.setPointerCapture(e.pointerId); e.preventDefault(); return; }
        if (g.speed) return;
        if (!e.shiftKey && this.clock) { this.sel.clear(); this.clock.seek(pos(e).t); drag = { kind: 'scrub' }; wrap.setPointerCapture(e.pointerId); paint(); }
      });
      wrap.addEventListener('pointermove', (e) => {
        if (!drag) return; const g = wrap._g; const q = pos(e);
        if (drag.kind === 'scrub') { if (this.clock) this.clock.seek(q.t); return; }
        if (drag.kind === 'key') {
          const k = drag.k; if (!drag.moved && Math.abs(q.t - drag.p0.t) < q.tol / 2 && Math.abs(q.v - drag.p0.v) < (g.hi - g.lo) * 0.01) return; drag.moved = true;
          delete k.r; const dt = q.t - drag.p0.t; const t = clamp(drag.t0 + dt, 0, g.dur); k.t = this.clock ? this.clock.snap(t, q.tol) : this._snap(t);
          if (typeof drag.v0 === 'number') { let v = clamp(drag.v0 + (q.v - drag.p0.v), g.min, g.max); if (g.b.opts.step) v = Math.round(v / g.b.opts.step) * g.b.opts.step; k.v = +v.toFixed(6); }
          g.ks.sort((x, y) => x.t - y.t); this.sel = new Set([g.p + '@' + k.t]); this._roveAll(); paint(); return;
        }
        if (drag.kind === 'handle') {
          const k = drag.k, a = drag.a; const dt = k.t - a.t, dv = k.v - a.v; const h = (k.h || BEZIER_DEFAULT).slice();
          h[drag.hi] = clamp((q.t - a.t) / Math.max(1e-9, dt), 0, 1); h[drag.hi + 1] = Math.abs(dv) > 1e-9 ? clamp((q.v - a.v) / dv, -2, 3) : h[drag.hi + 1];
          k.i = 'bezier'; k.h = h.map((x) => +x.toFixed(4)); paint();
        }
      });
      const up = () => { if (!drag) return; const d = drag; drag = null; const g = wrap._g; if ((d.kind === 'key' && d.moved) || d.kind === 'handle') { this._record(g.p, d.before, g.ks, d.kind === 'key' ? 'Move key' : 'Bezier handles'); this._changed(); } };
      wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);
      wrap.addEventListener('dblclick', (e) => { const g = wrap._g; if (g.speed || e.target.closest('.lab-g-key') || e.target.closest('.lab-g-handle') || e.target.closest('.lab-gedit-label')) return; const q = pos(e); const v = g.vAt(q.t); this.setKey(g.p, q.t, v != null && !isNaN(v) ? v : g.b.value); });
      return wrap;
    }
    _drawHead() {
      if (!this._headLine || !this.clock) return; const dur = Math.max(1e-6, this.clock.duration);
      this._headLine.style.left = 'calc(96px + (100% - 96px) * ' + clamp(this.clock.t / dur, 0, 1).toFixed(5) + ')';
      if (this._graphHead && this._graphHead.isConnected) { const x = (clamp(this.clock.t / (this._graphDur || dur), 0, 1) * (this._graphW || 1000)).toFixed(1); this._graphHead.setAttribute('x1', x); this._graphHead.setAttribute('x2', x); }
      const t = this.clock.t; this._marks.forEach((m, b) => { m.classList.toggle('on', this.onKey(b.path, t)); });
    }
  }

  // ================================================================ ModMatrix: sources, routes, evaluate, slider bands
  class ModMatrix extends Emitter {
    // new ModMatrix(pane, { clock, project, tool })
    constructor(pane, o) {
      super(); o = o || {}; this.pane = pane; this.o = o; this.clock = o.clock || pane.clock; this.sources = new Map(); this.routes = []; this.intensity = 1; this.enabled = true;
      this._t = NaN; this._deltas = {}; this._bands = new Map(); this._values = {};
      pane.mod = this;
      // generators: pure functions of the clock time, so live and offline agree frame for frame and nothing needs baking
      this.gens = { lfo: { rate: 0.5, phase: 0, shape: 'sine' }, noise: { rate: 2, seed: 1, smooth: true } };
      if (o.generators !== false) {
        this.addSource('lfo', { label: 'lfo', group: 'generator', gen: (t) => ModMatrix.lfo(t, this.gens.lfo) });
        this.addSource('noise', { label: 'noise', group: 'generator', gen: (t) => ModMatrix.noise(t, this.gens.noise) });
      }
      if (o.project && o.project.register) o.project.register('mod', { get: () => this.getState(), set: (s) => this.setState(s) });
    }
    // addSource('bass', { label:'bass', live: () => 0..1, group:'audio', enabled: () => bool, bake: async (fps, t0, n) => Float32Array })
    static lfo(t, g) { const ph = ((t * (g.rate || 0)) + (g.phase || 0)) % 1; const x = ph < 0 ? ph + 1 : ph; switch (g.shape) { case 'triangle': return x < 0.5 ? x * 2 : 2 - x * 2; case 'saw': return x; case 'ramp down': return 1 - x; case 'square': return x < 0.5 ? 1 : 0; default: return 0.5 - 0.5 * Math.cos(2 * Math.PI * x); } }
    static hash(i, seed) { let x = (Math.imul(i | 0, 374761393) + Math.imul((seed | 0) + 1, 668265263)) | 0; x = Math.imul(x ^ (x >>> 13), 1274126177); x ^= x >>> 16; return (x >>> 0) / 4294967296; }
    static noise(t, g) { const x = t * (g.rate || 1); const i = Math.floor(x); const a = ModMatrix.hash(i, g.seed), b = ModMatrix.hash(i + 1, g.seed); if (g.smooth === false) return a; const f = x - i; const k = f * f * (3 - 2 * f); return a + (b - a) * k; }
    addSource(id, s) { const src = Object.assign({ id, label: id, live: () => 0, group: '', baked: null, bakeFps: 0, bakeT0: 0 }, s || {}); this.sources.set(id, src); this.emit('sources'); return src; }
    source(id) { return this.sources.get(id) || null; }
    setBaked(id, track, fps, t0) { const s = this.sources.get(id); if (!s) return; s.baked = track || null; s.bakeFps = fps || 0; s.bakeT0 = t0 || 0; this.emit('bake', { id }); }
    clearBaked() { this.sources.forEach((s) => { s.baked = null; }); this.emit('bake', {}); }
    get baked() { return [...this.sources.values()].some((s) => s.baked); }
    // the value of a source now (live) or at t (offline → baked track; no track → 0)
    sample(id, t) {
      const s = this.sources.get(id); if (!s) return 0;
      if (s.enabled && !s.enabled()) return 0;   // a source off in the tool (mode select) is silent live and offline
      if (s.gen) { if (t == null) t = this.clock ? this.clock.t : 0; const g = +s.gen(t); return isFinite(g) ? clamp(g, 0, 1) : 0; }
      const offline = this.clock && this.clock.offline;
      if (offline || (s.preferBaked && s.baked)) { if (!s.baked) return 0; const i = Math.round((t - s.bakeT0) * s.bakeFps); return (i >= 0 && i < s.baked.length) ? s.baked[i] : 0; }
      let v = +s.live(); if (!isFinite(v)) v = 0; return clamp(v, 0, 1);
    }
    active() { return this.enabled && this.routes.length > 0; }
    curve(v, c) { return c === 'exp' ? v * v : c === 'gate' ? (v > 0.5 ? 1 : 0) : c === 'inv' ? 1 - v : v; }
    // deltas per path at t, memoised per t (one evaluation per frame)
    evaluate(t) {
      if (t == null) t = this.clock ? this.clock.t : 0;
      if (t === this._t && this._evalFrame === (this.clock && this.clock._frameNo)) return this._deltas;
      this._t = t; this._evalFrame = this.clock && this.clock._frameNo;
      const d = {}; const vals = {};
      this.routes.forEach((r) => { if (!r.src || !r.dst || !r.amt) return; const b = sliderOf(this.pane, r.dst); if (!b) return; const v = vals[r.src] != null ? vals[r.src] : (vals[r.src] = this.sample(r.src, t)); d[r.dst] = (d[r.dst] || 0) + this.curve(v, r.curve) * (r.amt / 100) * rangeOf(b) * this.intensity; });
      this._deltas = d; this._values = vals; this._paintBands(); if (this._meters) this._paintMeters(t);
      return d;
    }
    // overrides for one root given its base values (after keys)
    apply(root, base, t) {
      const d = this.evaluate(t); const out = {}; const pre = root + '.';
      Object.keys(d).forEach((p) => { if (!p.startsWith(pre)) return; const k = p.slice(pre.length); const b = sliderOf(this.pane, p); if (!b) return; const v = +base[k]; if (!isFinite(v)) return; out[k] = clamp(v + d[p], b.opts.min, b.opts.max); });
      return out;
    }
    addRoute(r) { r = Object.assign({ id: uid(), src: '', dst: '', amt: 25, curve: 'lin' }, r || {}); this.routes.push(r); this._changed(); return r; }
    removeRoute(id) { this.routes = this.routes.filter((r) => r.id !== id); this._changed(); }
    getState() { return { routes: this.routes.map((r) => Object.assign({}, r)), intensity: this.intensity, enabled: this.enabled, gens: cloneV(this.gens) }; }
    setState(s) { if (!s) return; this.routes = (s.routes || []).map((r) => Object.assign({ id: uid(), amt: 25, curve: 'lin' }, r)); if (s.intensity != null) this.intensity = +s.intensity; this.enabled = s.enabled !== false; if (s.gens) { Object.keys(this.gens).forEach((k) => Object.assign(this.gens[k], s.gens[k] || {})); } this._changed(); }
    setGen(id, patch) { if (!this.gens[id]) return; Object.assign(this.gens[id], patch); this._t = NaN; this.emit('gens'); if (this.o.project) this.o.project.touch(); }
    _changed() { this._t = NaN; this._markRows(); if (this._rebuild) this._rebuild(); this.emit('change'); if (this.o.project) this.o.project.touch(); }
    // ---- rows: a ~ in the label of routed sliders, a band under the track from base to base + amount, a tick at the effective value
    _markRows() {
      const routed = new Set(this.routes.filter((r) => r.amt).map((r) => r.dst));
      this.pane.bindings().forEach((b) => { const p = b.path; if (!p) return; let m = this._bands.get(b); if (routed.has(p) && b.view === 'slider') { if (!m) { const w = b.element.querySelector('.lab-widget'); if (!w) return; m = { mark: el('i', 'lab-modmark', '~'), band: el('i', 'lab-modband'), tick: el('i', 'lab-modtick') }; m.mark.title = 'modulated'; (b._in || b._label).appendChild(m.mark); w.append(m.band, m.tick); this._bands.set(b, m); } } else if (m) { m.mark.remove(); m.band.remove(); m.tick.remove(); this._bands.delete(b); } });
    }
    _paintBands() {
      if (!this._bands.size) return;
      this._bands.forEach((m, b) => {
        const p = b.path; const min = b.opts.min, max = b.opts.max, span = max - min; if (!(span > 0)) return;
        const base = +b.value; let amt = 0; this.routes.forEach((r) => { if (r.dst === p) amt += (r.amt / 100) * span * this.intensity; });
        const d = this._deltas[p] || 0; const a = clamp(base, min, max), bb = clamp(base + amt, min, max), eff = clamp(base + d, min, max);
        const l = (Math.min(a, bb) - min) / span * 100, w = Math.abs(bb - a) / span * 100;
        m.band.style.left = l.toFixed(2) + '%'; m.band.style.width = w.toFixed(2) + '%'; m.tick.style.left = ((eff - min) / span * 100).toFixed(2) + '%';
      });
    }
    _paintMeters(t) { this._meters.forEach((bar, id) => { const v = this._values[id] != null ? this._values[id] : this.sample(id, t); bar.style.width = (clamp(v, 0, 1) * 100).toFixed(1) + '%'; }); }
    // ---- bake: tools supply `bake(fps, t0, dur)` returning { id: Float32Array }; the matrix stores and reports
    async ensureBaked(o) {
      o = o || {}; if (!this.o.bake) return false;
      const need = this.routes.some((r) => { const s = this.sources.get(r.src); return r.amt && s && !s.gen && (!s.enabled || s.enabled()); }) || o.force; if (!need) return false;
      const clock = this.clock; const fps = (o.fps || (clock ? clock.fps : 30)), t0 = 0, dur = o.dur || (clock ? clock.duration : 10);
      const key = [this.o.bakeKey ? this.o.bakeKey() : 'x', fps, dur.toFixed(3)].join('|');
      if (this._bakeKey === key && this.baked && !o.force) return true;
      this._baking = true; this.emit('bake-start'); if (this._bakeStat) this._bakeStat.set('baking…');
      try {
        const tracks = await this.o.bake(fps, t0, dur, (p) => { if (this._bakeStat) this._bakeStat.set('baking ' + Math.round(p * 100) + '%'); });
        if (tracks) { Object.keys(tracks).forEach((id) => { if (this.sources.has(id)) this.setBaked(id, tracks[id], fps, t0); }); this._bakeKey = key; }
        if (this._bakeStat) this._bakeStat.set(tracks ? ('baked ' + Object.keys(tracks).length + ' tracks · ' + Math.round(dur * fps) + ' f @ ' + fps) : 'nothing to bake');
        return !!tracks;
      } catch (e) { console.warn('bake:', e); if (this._bakeStat) this._bakeStat.set('bake failed · ' + (e && e.message || e)); return false; }
      finally { this._baking = false; this.emit('bake-end'); }
    }
    // record a live-only source (camera, mic) as a take while the clock plays
    record(id) {
      if (this._rec) { this._stopRecord(); return; }
      const s = this.sources.get(id); if (!s || !this.clock) return; const fps = this.clock.fps, n = Math.ceil(this.clock.duration * fps) + 1;
      const track = new Float32Array(n); const off = this.clock.on('time', () => { const i = Math.round(this.clock.t * fps); if (i >= 0 && i < n) track[i] = clamp(+s.live() || 0, 0, 1); });
      this._rec = { id, off, track, fps }; if (this._recBtn) this._recBtn.classList.add('rec'); flash('recording ' + s.label + ' · press again to stop');
      this.emit('record', { id, on: true });
    }
    _stopRecord() { const r = this._rec; if (!r) return; this._rec = null; r.off(); this.setBaked(r.id, r.track, r.fps, 0); const s = this.sources.get(r.id); if (s) s.preferBaked = true; if (this._recBtn) this._recBtn.classList.remove('rec'); flash('take recorded · ' + r.id); this.emit('record', { id: r.id, on: false }); }
    // ---- folder UI
    folder(o) {
      o = o || {}; const pane = this.pane; const f = o.folder || pane.addFolder({ title: o.title || 'Modulation', expanded: false });
      this._folder = f;
      const hold = { intensity: this.intensity, enabled: this.enabled };
      const bEn = f.addBinding(hold, 'enabled', { label: 'modulation on' }); bEn.on('change', (ev) => { this.enabled = !!ev.value; this._changed(); });
      const bIn = f.addBinding(hold, 'intensity', { label: 'intensity', min: 0, max: 3, step: 0.05 }); bIn.on('change', (ev) => { this.intensity = +ev.value; this._t = NaN; if (ev.last !== false && this.o.project) this.o.project.touch(); });
      this.on('change', () => { hold.intensity = this.intensity; hold.enabled = this.enabled; bIn.refresh(); bEn.refresh(); });
      // live meters
      const meters = el('div', 'lab-mod-meters'); const mrow = el('div', 'lab-row lab-full'); mrow.appendChild(meters); f.body.appendChild(mrow); this._meters = new Map();
      const buildMeters = () => { meters.textContent = ''; this._meters.clear(); this.sources.forEach((s) => { const m = el('div', 'lab-mod-meter'); const bar = el('i'); m.append(el('span', null, s.label), el('b', null, bar)); m.title = s.group ? s.group + ' · ' + s.id : s.id; meters.appendChild(m); this._meters.set(s.id, bar); }); };
      this.on('sources', buildMeters); buildMeters();
      // generators
      if (this.sources.has('lfo') || this.sources.has('noise')) {
        const g = this.gens; const gh = { lfoRate: g.lfo.rate, lfoShape: g.lfo.shape, lfoPhase: g.lfo.phase, noiseRate: g.noise.rate, noiseSeed: g.noise.seed };
        const gb = [];
        const bind = (key, label, opts, apply) => { const b = f.addBinding(gh, key, Object.assign({ label }, opts)); b.on('change', (ev) => { apply(ev.value); this._t = NaN; if (ev.last !== false) { this.emit('gens'); if (this.o.project) this.o.project.touch(); } }); gb.push([b, key]); return b; };
        if (this.sources.has('lfo')) {
          bind('lfoRate', 'lfo rate', { min: 0.05, max: 8, step: 0.05, unit: 'Hz' }, (v) => { g.lfo.rate = +v; });
          bind('lfoShape', 'lfo shape', { options: ['sine', 'triangle', 'saw', 'ramp down', 'square'] }, (v) => { g.lfo.shape = String(v); });
          bind('lfoPhase', 'lfo phase', { min: 0, max: 1, step: 0.01 }, (v) => { g.lfo.phase = +v; });
        }
        if (this.sources.has('noise')) {
          bind('noiseRate', 'noise rate', { min: 0.1, max: 20, step: 0.1, unit: 'Hz' }, (v) => { g.noise.rate = +v; });
          bind('noiseSeed', 'noise seed', { min: 1, max: 999, step: 1 }, (v) => { g.noise.seed = Math.round(+v); });
        }
        this.on('change', () => { gh.lfoRate = g.lfo.rate; gh.lfoShape = g.lfo.shape; gh.lfoPhase = g.lfo.phase; gh.noiseRate = g.noise.rate; gh.noiseSeed = g.noise.seed; gb.forEach(([b]) => b.refresh()); });
      }
      // routes
      const list = el('div', 'lab-routes'); const rrow = el('div', 'lab-row lab-full'); rrow.appendChild(list); f.body.appendChild(rrow);
      const dstOptions = () => pane.bindings().filter((b) => b.path && b.view === 'slider' && typeof b.opts.min === 'number' && typeof b.opts.max === 'number' && !b.opts.readonly && !/^(mod|keys|render)\./.test(b.path)).map((b) => [b.path, pane.pathLabel(b.path)]);
      const rebuild = () => {
        list.textContent = '';
        if (!this.routes.length) list.appendChild(el('div', 'lab-route-empty', 'no routes'));
        this.routes.forEach((r) => {
          const row = el('div', 'lab-route');
          const line = el('div', 'lab-route-line');
          const mkSel = (opts, cur, cls) => { const w = el('div', 'lab-widget lab-select ' + (cls || '')); const s = el('select'); opts.forEach(([v, t]) => { const op = el('option', null, t); op.value = v; s.appendChild(op); }); if (![...s.options].some((op) => op.value === String(cur))) { const op = el('option', null, cur ? String(cur) : '—'); op.value = cur || ''; s.prepend(op); } s.value = String(cur || ''); w.appendChild(s); return [w, s]; };
          const [sw, ss] = mkSel([...this.sources.values()].map((s) => [s.id, s.label]), r.src, 'lab-route-src');
          const [dw, ds] = mkSel(dstOptions(), r.dst, 'lab-route-dst');
          const [cw, cs] = mkSel([['lin', 'lin'], ['exp', 'exp'], ['gate', 'gate'], ['inv', 'inv']], r.curve, 'lab-route-curve');
          const x = el('button', 'lab-qx', '×'); x.type = 'button'; x.title = 'remove route';
          ss.addEventListener('change', () => { r.src = ss.value; this._changed(); }); ds.addEventListener('change', () => { r.dst = ds.value; this._changed(); }); cs.addEventListener('change', () => { r.curve = cs.value; this._changed(); });
          x.addEventListener('click', () => this.removeRoute(r.id));
          line.append(sw, el('span', 'lab-route-arrow', '→'), dw, cw, x);
          row.appendChild(line);
          const holder = { amt: r.amt }; const amt = new LabUI.Binding(f, holder, 'amt', { label: 'amount', min: -100, max: 100, step: 1, unit: '%' });
          amt.on('change', (ev) => { r.amt = +ev.value; this._t = NaN; this._markRows(); if (ev.last !== false) { this.emit('change'); if (this.o.project) this.o.project.touch(); } });
          row.appendChild(amt.element); list.appendChild(row);
        });
      };
      this._rebuild = rebuild; rebuild();
      f.on('fold', (ev) => { if (ev.expanded) rebuild(); });
      const btns = f.addButtons([{ title: '+ route', key: 'add' }, { title: 'Bake', key: 'bake' }, { title: 'Record take', key: 'rec' }], { cols: 3 });
      btns.buttons.add.addEventListener('click', () => { const first = [...this.sources.keys()][0] || ''; this.addRoute({ src: first }); });
      btns.buttons.bake.addEventListener('click', () => this.ensureBaked({ force: true }));
      this._recBtn = btns.buttons.rec; btns.buttons.rec.classList.add('lab-rec');
      btns.buttons.rec.addEventListener('click', () => { const live = [...this.sources.values()].filter((s) => s.recordable); if (!live.length) { flash('no recordable source (camera / mic)'); return; } this.record(this._rec ? this._rec.id : live[0].id); });
      this._bakeStat = f.addStatus('');
      // right-click a slider → modulate by…
      pane.element.addEventListener('contextmenu', (e) => {
        const row = e.target.closest('.lab-row'); if (!row) return; const b = pane.bindings().find((x) => x.element === row); if (!b || b.view !== 'slider' || !b.path || !this.sources.size) return;
        e.preventDefault();
        LabUI.contextMenu(e.clientX, e.clientY, [...this.sources.values()].map((s) => ({ title: 'Modulate by ' + s.label, onClick: () => { this.addRoute({ src: s.id, dst: b.path }); f.expanded = true; } })).concat(this.routes.some((r) => r.dst === b.path) ? [{ sep: true }, { title: 'Remove routes to this', danger: true, onClick: () => { this.routes = this.routes.filter((r) => r.dst !== b.path); this._changed(); } }] : []));
      });
      this._markRows();
      return f;
    }
  }

  // ================================================================ Bake: offline audio analysis into per-frame tracks (kit-adjacent helper)
  const Bake = {
    // audio(buffer, { fps, t0, dur, bands: { id: [lo, hi, attackMs, releaseMs] }, onsets: { id: [lo, hi] } }) → { tracks: { id: Float32Array }, onsets: { id: [t...] }, bpm }
    async audio(buffer, o) {
      o = o || {}; const fps = o.fps || 30, t0 = o.t0 || 0, dur = o.dur != null ? o.dur : buffer.duration; const n = Math.max(1, Math.round(dur * fps));
      const sr = buffer.sampleRate; const len = Math.min(buffer.length, Math.ceil((t0 + dur) * sr) + sr);
      const bands = o.bands || { bass: [0, 375, 30, 300], mid: [375, 3750, 30, 250], high: [3750, 0, 20, 200], rms: [0, 0, 20, 300] };
      const tracks = {}; const win = Math.round(sr * 0.043);
      const render = async (lo, hi) => {
        const ctx = new OfflineAudioContext(1, len, sr); const src = ctx.createBufferSource(); src.buffer = buffer; let node = src;
        if (lo) node = node.connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: lo, Q: 0.707 }));
        if (hi) node = node.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: hi, Q: 0.707 }));
        node.connect(ctx.destination); src.start(0); const out = await ctx.startRendering(); return out.getChannelData(0);
      };
      const ids = Object.keys(bands); let done = 0;
      for (const id of ids) {
        const [lo, hi, atk, rel] = bands[id]; const sig = await render(lo, hi);
        const raw = new Float32Array(n);
        for (let i = 0; i < n; i++) { const e = Math.min(sig.length, Math.round((t0 + i / fps) * sr)); const s0 = Math.max(0, e - win); let s = 0; for (let k = s0; k < e; k++) s += sig[k] * sig[k]; raw[i] = e > s0 ? Math.sqrt(s / (e - s0)) : 0; }
        // follower (attack / release in ms at the frame rate), then normalise to the clip's loud part
        const tr = new Float32Array(n); let y = 0; const dt = 1000 / fps;
        for (let i = 0; i < n; i++) { const x = raw[i]; const tau = x > y ? (atk || 20) : (rel || 300); y += (1 - Math.exp(-dt / Math.max(tau, 0.01))) * (x - y); tr[i] = y; }
        const sorted = Array.from(tr).sort((a, b) => a - b); const ref = sorted[Math.floor(sorted.length * 0.97)] || 1e-6;
        for (let i = 0; i < n; i++) tr[i] = clamp(tr[i] / Math.max(ref, 1e-6), 0, 1);
        tracks[id] = tr; done++; if (o.onProgress) o.onProgress(done / (ids.length + Object.keys(o.onsets || {}).length));
      }
      // onsets: half-wave rectified spectral flux of a band-limited signal, peak-picked against a running median
      const onsets = {}; let bpm = 0;
      for (const id of Object.keys(o.onsets || {})) {
        const [lo, hi] = o.onsets[id]; const sig = await render(lo, hi); const N = 1024; const re = new Float32Array(N), im = new Float32Array(N); const prev = new Float32Array(N / 2); const flux = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const e = Math.min(sig.length, Math.round((t0 + i / fps) * sr)); const s0 = e - N;
          for (let k = 0; k < N; k++) { const j = s0 + k; const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / N); re[k] = (j >= 0 && j < sig.length ? sig[j] : 0) * w; im[k] = 0; }
          Bake._fft(re, im); let fl = 0;
          for (let k = 1; k < N / 2; k++) { const m = Math.log1p(100 * Math.hypot(re[k], im[k]) / N * 2); const d = m - prev[k]; if (d > 0) fl += d; prev[k] = m; }
          flux[i] = fl;
        }
        const times = []; const track = new Float32Array(n); const medWin = Math.round(0.6 * fps); let last = -1e9;
        for (let i = 1; i < n - 1; i++) {
          const a = Math.max(0, i - medWin); const seg = Array.from(flux.subarray(a, i + 1)).sort((x, y) => x - y); const thr = 1.5 * (seg[seg.length >> 1] || 0) + 1e-3;
          if (flux[i] > thr && flux[i] >= flux[i - 1] && flux[i] > flux[i + 1] && (i - last) / fps > 0.12) { last = i; times.push(t0 + i / fps); track[i] = 1; }
        }
        onsets[id] = times; tracks[id] = track; done++; if (o.onProgress) o.onProgress(done / (ids.length + Object.keys(o.onsets).length));
        if (!bpm && times.length >= 8) {
          const ioi = times.slice(1).map((x, k) => x - times[k]).filter((d) => d > 0.25 && d < 1.5).sort((a, b) => a - b);
          if (ioi.length >= 6) { let p = ioi[ioi.length >> 1]; while (60 / p < 80) p /= 2; while (60 / p > 160) p *= 2; bpm = 60 / p; }
        }
      }
      return { tracks, onsets, bpm, fps, t0, n };
    },
    _fft(re, im) {
      const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len; const wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2; const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } } }
    },
  };

  // ================================================================ MIDI learn: CC → control, soft takeover, per-device map in localStorage
  class MidiLearn extends Emitter {
    constructor(pane, o) {
      super(); o = o || {}; this.pane = pane; this.o = o; this.tool = o.tool || 'lab'; this.learning = false; this.pending = null; this.maps = {}; this.access = null; this.device = ''; this._last = new Map(); this._tags = new Map();
      this.supported = !!(global.navigator && global.navigator.requestMIDIAccess);
      pane.midi = this; this._load();
      if (this.supported) this._open();
      if (o.keys !== false) { keys.bind('KeyM', 'shift', () => this.toggle(), { label: 'MIDI learn' }); keys.bind('Escape', '', (e) => { if (this.learning) this.exit(); }, { label: 'Leave MIDI learn' }); }
      pane.element.addEventListener('click', (e) => { if (!this.learning) return; const row = e.target.closest('.lab-row'); if (!row) return; const b = pane.bindings().find((x) => x.element === row); if (!b || !b.path) return; e.preventDefault(); e.stopPropagation(); this.pending = b; pane.element.querySelectorAll('.lab-learn-pending').forEach((n) => n.classList.remove('lab-learn-pending')); row.classList.add('lab-learn-pending'); flash('move a knob for ' + (pane.pathLabel(b.path) || b.path)); }, true);
      pane.element.addEventListener('contextmenu', (e) => { if (!this.learning) return; const row = e.target.closest('.lab-row'); if (!row) return; const b = pane.bindings().find((x) => x.element === row); if (!b || !b.path || !this.maps[b.path]) return; e.preventDefault(); e.stopPropagation(); this.unmap(b.path); });
      this._tagRows();
    }
    get key() { return 'lab:' + this.tool + ':midi'; }
    _load() { try { const all = JSON.parse(global.localStorage.getItem(this.key) || '{}'); this._all = all; } catch (_) { this._all = {}; } }
    _save() { try { this._all[this.device || 'default'] = this.maps; global.localStorage.setItem(this.key, JSON.stringify(this._all)); } catch (_) {} }
    async _open() {
      try { this.access = await global.navigator.requestMIDIAccess({ sysex: false }); } catch (e) { console.warn('midi:', e); return; }
      const attach = () => { this.access.inputs.forEach((inp) => { if (inp._labBound) return; inp._labBound = true; inp.onmidimessage = (m) => this._onMessage(m, inp); }); const first = [...this.access.inputs.values()][0]; const name = first ? (first.name || first.id) : ''; if (name !== this.device) { this.device = name; this.maps = this._all[name] || this._all.default || {}; this._tagRows(); } };
      attach(); this.access.onstatechange = attach;
    }
    toggle() { if (this.learning) this.exit(); else this.enter(); }
    enter() { if (!this.supported) { flash('Web MIDI is not available in this browser'); return; } this.learning = true; this.pending = null; this.pane.element.classList.add('lab-learn'); flash('MIDI learn: click a control, move a knob · Esc to finish'); this.emit('learn', { on: true }); }
    exit() { this.learning = false; this.pending = null; this.pane.element.classList.remove('lab-learn'); this.pane.element.querySelectorAll('.lab-learn-pending').forEach((n) => n.classList.remove('lab-learn-pending')); flash('MIDI learn off'); this.emit('learn', { on: false }); }
    map(path, m) { this.maps[path] = Object.assign({ ch: 0, cc: 0, mode: 'abs' }, m); this._last.delete(path); this._save(); this._tagRows(); this.emit('map', { path, map: this.maps[path] }); }
    unmap(path) { delete this.maps[path]; this._save(); this._tagRows(); flash('unlearned ' + (this.pane.pathLabel(path) || path)); this.emit('map', { path, map: null }); }
    _tagRows() {
      const byPath = {}; Object.keys(this.maps).forEach((p) => { byPath[p] = this.maps[p]; });
      this.pane.bindings().forEach((b) => { const p = b.path; if (!p) return; let t = this._tags.get(b); const m = byPath[p]; if (m) { if (!t) { t = el('i', 'lab-miditag'); (b._in || b._label).appendChild(t); this._tags.set(b, t); } t.textContent = 'cc' + m.cc; t.title = 'MIDI ch ' + (m.ch + 1) + ' cc ' + m.cc + (m.mode === 'rel' ? ' · relative' : ''); } else if (t) { t.remove(); this._tags.delete(b); } });
    }
    _onMessage(m, inp) {
      const d = m.data; if (!d || d.length < 3) return; const status = d[0] & 0xf0, ch = d[0] & 0x0f;
      if (status === 0xb0) this.cc(ch, d[1], d[2]);
      else if (status === 0x90 && d[2] > 0) this.note(ch, d[1], d[2]);
    }
    note(ch, n, vel) { this.emit('note', { ch, note: n, vel }); }
    // a CC arrives: in learn mode with a pending row it maps; otherwise it drives the mapped control with soft takeover
    cc(ch, cc, val) {
      if (this.learning && this.pending) { const b = this.pending; this.pending = null; this.map(b.path, { ch, cc, mode: 'abs' }); b.element.classList.remove('lab-learn-pending'); flash('mapped cc' + cc + ' → ' + (this.pane.pathLabel(b.path) || b.path)); return; }
      const path = Object.keys(this.maps).find((p) => this.maps[p].cc === cc && this.maps[p].ch === ch); if (!path) return;
      const b = this.pane.byPath(path); if (!b) return; const m = this.maps[path]; const x = val / 127;
      if (b.view === 'checkbox') { b._commit(val > 63, true); return; }
      if (b.view === 'list') { const opts = LabUI.normalizeOptions ? LabUI.normalizeOptions(b.opts.options) : null; const sel = b.element.querySelector('select'); const n = sel ? sel.options.length : 0; if (n) { const i = Math.min(n - 1, Math.floor(x * n)); const v = opts ? opts[i].value : sel.options[i].value; b._commit(v, true); } return; }
      if (b.view !== 'slider') return;
      const min = b.opts.min, max = b.opts.max; if (typeof min !== 'number' || typeof max !== 'number') return;
      if (m.mode === 'rel') { const d = val >= 64 ? val - 128 : val; const step = b.opts.step || (max - min) / 100; b._commit(clamp(b.value + d * step, min, max), true); return; }
      const cur = (b.value - min) / (max - min); const prev = this._last.get(path);
      // soft takeover: the knob grabs the value once it crosses it (or lands within a hair of it)
      const grabbed = prev == null ? Math.abs(x - cur) < 0.03 : ((prev - cur) * (x - cur) <= 0 || Math.abs(x - cur) < 0.03);
      this._last.set(path, x);
      if (!grabbed && !m.grabbed) return; m.grabbed = true;
      const step = b.opts.step || 0; let v = min + x * (max - min); if (step > 0) v = Math.round(v / step) * step; b._commit(+v.toFixed(6), true);
    }
  }

  // ================================================================ Palette: fuzzy search over controls, presets and actions; `/` filters the panel
  class Palette extends Emitter {
    constructor(pane, o) {
      super(); o = o || {}; this.pane = pane; this.o = o; this.open_ = false;
      const box = el('div', 'lab-palette'); box.hidden = true; const input = el('input'); input.type = 'text'; input.placeholder = 'search controls, presets, actions · name=value sets'; input.spellcheck = false;
      const list = el('div', 'lab-palette-list'); box.append(input, list); (o.host || pane.element.parentElement || doc.body).appendChild(box);
      this.box = box; this.input = input; this.list = list; this.items = []; this.cursor = 0; this.mode = 'palette';
      input.addEventListener('input', () => { if (this.mode === 'filter') this.filter(input.value); else this._render(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); this.close(); if (this.mode === 'filter') this.filter(''); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); this.cursor = Math.min(this.cursor + 1, Math.max(0, this.items.length - 1)); this._paint(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this.cursor = Math.max(0, this.cursor - 1); this._paint(); }
        else if (e.key === 'Enter') { e.preventDefault(); this.run(); }
        e.stopPropagation();
      });
      input.addEventListener('blur', () => { setTimeout(() => { if (this.open_ && !box.contains(doc.activeElement)) this.close(); }, 120); });
      list.addEventListener('pointerdown', (e) => { const r = e.target.closest('.lab-palette-item'); if (!r) return; e.preventDefault(); this.cursor = +r.dataset.i; this.run(); });
      if (o.keys !== false) { keys.bind('KeyK', 'mod', () => this.toggle('palette'), { label: 'Command palette' }); keys.bind('Slash', '', () => this.toggle('filter'), { label: 'Filter the panel' }); }
    }
    toggle(mode) { if (this.open_ && this.mode === mode) this.close(); else this.open(mode); }
    open(mode) { this.mode = mode || 'palette'; this.open_ = true; this.box.hidden = false; this.box.classList.toggle('lab-palette-filter', this.mode === 'filter'); this.input.placeholder = this.mode === 'filter' ? 'filter the panel · Esc clears' : 'search controls, presets, actions · name=value sets'; this.input.value = ''; this.cursor = 0; this._render(); this.input.focus(); }
    close() { this.open_ = false; this.box.hidden = true; this.input.blur(); }
    // ---- candidates
    candidates() {
      const out = []; const pane = this.pane;
      pane.bindings().forEach((b) => { if (!b.path || b.hidden) return; const lab = pane.pathLabel(b.path) || b.label; out.push({ kind: 'param', label: lab, detail: typeof b.value === 'number' ? LabUI.fmt(b.value, b.opts.step || 0.01, b.unit) : String(b.value), binding: b }); });
      const grid = this.o.presets || pane.presets; if (grid && grid.buttons) Object.keys(grid.buttons).forEach((name) => { const b = grid.buttons[name]; out.push({ kind: 'preset', label: b.title || name, detail: 'preset', run: () => (grid.pick ? grid.pick(name) : grid.select(name)) }); });
      keys.list().forEach((k, i) => { if (!k.label) return; const b = keys._b[i]; out.push({ kind: 'action', label: k.label, detail: Palette.kbd(k), run: () => b.fn({}) }); });
      return out;
    }
    static kbd(k) { const m = k.mods ? k.mods.split('+').map((x) => ({ mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃', meta: '⌘' })[x] || x).join('') : ''; return m + k.code.replace(/^Key|^Digit/, '').replace('Comma', ',').replace('Period', '.').replace('Slash', '/').replace('Backslash', '\\').replace('Space', '␣'); }
    static score(q, s) {
      q = q.toLowerCase(); s = s.toLowerCase(); if (!q) return 1; if (s.includes(q)) return 100 - s.indexOf(q);
      let i = 0, sc = 0, run = 0; for (let j = 0; j < s.length && i < q.length; j++) { if (s[j] === q[i]) { i++; run++; sc += run; } else run = 0; }
      return i === q.length ? sc : 0;
    }
    _render() {
      const q = this.input.value; let set = q; const m = q.match(/^\s*([^=]+?)\s*=\s*(.+)$/); if (m) set = m[1];
      const cands = this.candidates().map((c) => Object.assign({ s: Palette.score(set, c.label) }, c)).filter((c) => c.s > 0).sort((a, b) => b.s - a.s || a.label.localeCompare(b.label));
      this.items = cands.slice(0, 24); this.cursor = Math.min(this.cursor, Math.max(0, this.items.length - 1)); this._paint();
    }
    _paint() { this.list.textContent = ''; this.items.forEach((it, i) => { const r = el('div', 'lab-palette-item lab-palette-' + it.kind + (i === this.cursor ? ' sel' : '')); r.dataset.i = String(i); r.append(el('span', 'lab-palette-label', it.label), el('span', 'lab-palette-detail', it.detail || '')); this.list.appendChild(r); }); }
    run() {
      const it = this.items[this.cursor]; if (!it) return; const q = this.input.value; const m = q.match(/^\s*([^=]+?)\s*=\s*(.+)$/);
      if (it.kind === 'param') {
        const b = it.binding;
        if (m) { const raw = m[2].trim(); let v; if (b.view === 'slider') { v = parseFloat(raw); if (isNaN(v)) { flash('not a number'); return; } if (typeof b.opts.min === 'number') v = clamp(v, b.opts.min, b.opts.max); } else if (b.view === 'checkbox') v = /^(1|true|on|yes)$/i.test(raw); else v = raw; b._commit(v, true); flash((this.pane.pathLabel(b.path) || b.label) + ' = ' + raw); this.close(); return; }
        this.close(); b.focus(); b.element.classList.add('lab-flash-row'); setTimeout(() => b.element.classList.remove('lab-flash-row'), 1200); return;
      }
      this.close(); try { it.run(); } catch (e) { console.warn(e); }
    }
    // filter the panel in place: rows that do not match are hidden, empty folders collapse
    filter(q) {
      const pane = this.pane; q = (q || '').trim().toLowerCase();
      pane.element.classList.toggle('lab-filtering', !!q);
      pane.bindings().forEach((b) => { const lab = (pane.pathLabel(b.path || '') || b.label || '').toLowerCase(); const hit = !q || lab.includes(q); b.element.classList.toggle('lab-filtered-out', !hit); });
      pane.folders().forEach((f) => { const any = !q || f.bindings().some((b) => !b.element.classList.contains('lab-filtered-out')); f.element.classList.toggle('lab-filtered-out', !any); });
    }
  }

  // ================================================================ Pins: alt+P mirrors a control into a Pinned folder at the top of the panel
  class Pins extends Emitter {
    constructor(pane, o) {
      super(); o = o || {}; this.pane = pane; this.o = o; this.paths = []; this.mirrors = new Map(); this.folder = null;
      pane.pins = this;
      if (o.project && o.project.register) o.project.register('pins', { get: () => ({ paths: this.paths.slice() }), set: (s) => { this.clear(); ((s && s.paths) || []).forEach((p) => this.pin(p, { quiet: true })); } });
      // keep mirror and original in step
      pane.on('change', (ev) => { if (!ev || !ev.target || !ev.target.path) return; const p = ev.target.path; const m = this.mirrors.get(p); if (!m) return; const orig = pane.byPath(p); if (ev.target === m && orig) orig.refresh(); else if (ev.target === orig) m.refresh(); });
      pane.on('state', () => this.mirrors.forEach((m) => m.refresh()));
      if (o.keys !== false) keys.bind('KeyP', 'alt', () => this.toggleFocused(), { label: 'Pin / unpin the focused control' });
    }
    _folder() {
      if (this.folder) return this.folder;
      const f = this.pane.addFolder({ title: 'Pinned', expanded: true }); f.element.classList.add('lab-pinned');
      const body = this.pane.body || this.pane.element; body.insertBefore(f.element, body.firstChild);
      this.folder = f; return f;
    }
    toggleFocused() { const b = this.pane.focusedBinding(); if (!b || !b.path) { flash('focus a control, then alt+P'); return; } if (this.paths.includes(b.path)) this.unpin(b.path); else this.pin(b.path); }
    pin(path, o) {
      if (this.paths.includes(path)) return this.mirrors.get(path); const orig = this.pane.byPath(path); if (!orig) return null;
      const f = this._folder(); const opts = Object.assign({}, orig.opts, { label: this.pane.pathLabel(path) || orig.label, hidden: false, inline: true });
      delete opts.onChange; const m = f.addBinding(orig.obj, orig.key, opts); m.element.classList.add('lab-pin-row'); m._pinOf = path;
      const x = el('button', 'lab-qx lab-pin-x', '×'); x.type = 'button'; x.title = 'unpin (alt+P)'; x.addEventListener('click', () => this.unpin(path)); m.element.appendChild(x);
      this.paths.push(path); this.mirrors.set(path, m); this.pane._byPath = null;
      if (!(o && o.quiet)) { flash('pinned ' + opts.label); if (this.o.project) this.o.project.touch(); } this.emit('change'); return m;
    }
    unpin(path, o) {
      const m = this.mirrors.get(path); if (!m) return; m.element.remove(); const f = this.folder; if (f) f._children = f._children.filter((c) => c !== m);
      this.mirrors.delete(path); this.paths = this.paths.filter((p) => p !== path); this.pane._byPath = null;
      if (!this.paths.length && f) { f.element.remove(); this.pane._children = this.pane._children.filter((c) => c !== f); this.folder = null; }
      if (!(o && o.quiet)) { flash('unpinned'); if (this.o.project) this.o.project.touch(); } this.emit('change');
    }
    clear() { this.paths.slice().forEach((p) => this.unpin(p, { quiet: true })); }
  }

  LabUI.Timeline = Timeline; LabUI.ModMatrix = ModMatrix; LabUI.Pins = Pins; LabUI.Bake = Bake; LabUI.MidiLearn = MidiLearn; LabUI.Palette = Palette;
})(typeof window !== 'undefined' ? window : globalThis);
