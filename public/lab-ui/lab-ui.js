/* ============================================================================
   lab-ui — shared interface kit for the hubmerto tools (script, no deps)

   window.LabUI = {
     shell(opts)        builds the app frame: top bar, side column, viewport, status strip
     Pane               Tweakpane-compatible subset: addFolder / addBinding / addButton /
                        addBlade({view:'list'}) / addButtons / addStatus / addProgress /
                        addPresets (text or thumbnails) / addNote / addSeparator / refresh / on('change')
     fmt(value, step)   number formatting shared by every slider
     History / Project / LabStore / keys / flash   state layer: see "state layer" below
   }
   State: pane.track(name, obj) declares a root; bindings on it get .path ("name.key"), .default,
   .apply(v) / .reset() / .nudge(dir, mult) / .edit() / .focus(). pane.getState() / setState(state, {label,
   noHistory, source}) move whole states and emit 'state' {paths, source}. pane.history coalesces drags and
   nudges (600 ms), undo/redo (mod+Z, mod+shift+Z), transactions, snapshots. new LabUI.Project(pane, {...})
   autosaves to IndexedDB, restores before first paint, copies file sources into OPFS, re-links, saves and
   opens .json projects (mod+S / mod+O). Keyboard: arrows nudge (shift x10, alt x0.1), digits type, double-click
   a label resets (alt: the folder), wheel only on a focused row.

   Binding options: { label, min, max, step, options, view, readonly, format, unit,
                      hidden, disabled, onChange }
     view: 'slider' (number, default) | 'list' | 'checkbox' | 'color' | 'text' |
           'textarea' | 'graph' (readonly monitor)
   Every control returns an object with .on(event, fn), .refresh(), .hidden, .disabled,
   .label, .element, and for bindings .value (get/set, writes through to the object).
   ============================================================================ */
(function (global) {
  'use strict';

  const doc = global.document;
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function decimals(step) {
    if (!isFinite(step) || step <= 0) return 2;
    const s = String(step);
    if (s.includes('e-')) return +s.split('e-')[1];
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }
  function fmt(v, step, unit) {
    if (typeof v !== 'number' || !isFinite(v)) return String(v);
    const d = step != null ? decimals(step) : (Number.isInteger(v) ? 0 : 2);
    return v.toFixed(d) + (unit || '');
  }

  // ---------------------------------------------------------------- emitter
  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    off(ev, fn) { const a = this._h[ev]; if (a) this._h[ev] = a.filter((f) => f !== fn); return this; }
    emit(ev, payload) { (this._h[ev] || []).forEach((f) => f(payload)); }
  }

  // ---------------------------------------------------------------- base control
  class Control extends Emitter {
    constructor(parent, element) {
      super();
      this.parent = parent;
      this.element = element;
      this._hidden = false;
      this._disabled = false;
    }
    get hidden() { return this._hidden; }
    set hidden(v) { this._hidden = !!v; this.element.hidden = this._hidden; }
    get disabled() { return this._disabled; }
    set disabled(v) { this._disabled = !!v; this.element.classList.toggle('lab-disabled', this._disabled); }
    dispose() { this.element.remove(); if (this.parent) this.parent._children = this.parent._children.filter((c) => c !== this); }
    refresh() {}
    get pane() { let p = this.parent; while (p && p.parent) p = p.parent; return p && p.getState ? p : null; }
    get folder() { let p = this.parent; return p && p.parent ? p : null; }
    _record(paths, befores, afters, last) { const pn = this.pane; if (!pn || !pn.history || paths.some((p) => !p)) return; pn.history.record(paths, befores, afters, last); }
  }

  // ---------------------------------------------------------------- binding
  class Binding extends Control {
    constructor(parent, obj, key, o) {
      const row = el('div', 'lab-row');
      super(parent, row);
      this.obj = obj; this.key = key; this.opts = o = o || {};
      this._label = el('label', null, o.label != null ? o.label : key);
      row.appendChild(this._label);
      const v = obj[key];
      let view = o.view;
      if (!view) {
        if (o.options) view = 'list';
        else if (typeof v === 'boolean') view = 'checkbox';
        else if (typeof v === 'number') view = 'slider';
        else if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) view = 'color';
        else view = 'text';
      }
      this.view = view;
      const build = Binding.views[view] || Binding.views.text;
      build.call(this, row, o);
      // instrument rows: the label lives inside the field, not in a column to its left
      if (o.inline !== false) {
        const text = this._label.textContent;
        const w = row.querySelector('.lab-widget');
        const c = row.querySelector('.lab-check');
        if (w && !row.classList.contains('lab-full')) { this._in = el('span', 'lab-in', text); w.prepend(this._in); row.classList.add('lab-inline'); }
        else if (c) { this._in = el('span', 'lab-in', text); c.appendChild(this._in); row.classList.add('lab-inline'); }
      }
      if (o.hidden) this.hidden = true;
      if (o.disabled) this.disabled = true;
      if (o.onChange) this.on('change', (ev) => o.onChange(ev.value, ev));
      this.default = o.default !== undefined ? cloneV(o.default) : cloneV(v);
      // double-click a label resets the value (alt: the whole folder)
      const onDbl = (e) => { if (o.readonly) return; e.preventDefault(); e.stopPropagation(); if (e.altKey && this.folder) this.folder.resetAll(); else this.reset(); };
      this._label.addEventListener('dblclick', onDbl);
      if (this._in) this._in.addEventListener('dblclick', onDbl);
      const onLock = (e) => { if (!e.altKey || o.readonly) return; e.preventDefault(); e.stopPropagation(); this.locked = !this.locked; };
      this._label.addEventListener('click', onLock);
      if (this._in) this._in.addEventListener('click', onLock);
    }
    get label() { return this._label.textContent; }
    set label(t) { this._label.textContent = t; if (this._in) this._in.textContent = t; }
    get value() { return this.obj[this.key]; }
    set value(v) { this.obj[this.key] = v; this.refresh(); }
    get path() { const pn = this.pane; const r = pn && pn._rootName(this.obj); return r ? r + '.' + this.key : null; }
    get unit() { return this.opts.unit || ''; }
    _commit(v, last) {
      const prev = this.obj[this.key];
      this.obj[this.key] = v;
      this.refresh();
      this._record([this.path], [prev], [v], last !== false);
      this.emit('change', { value: v, last: last !== false, target: this });
    }
    // programmatic set: no history entry; emits change unless silent
    apply(v, o) { this.obj[this.key] = v; this.refresh(); if (!o || !o.silent) this.emit('change', { value: v, last: true, target: this, programmatic: true }); }
    reset() { if (this.default !== undefined && this.obj[this.key] !== this.default) this._commit(cloneV(this.default), true); }
    nudge(dir, mult) { if (this._nudge) this._nudge(dir, mult); }
    edit(prefill) { if (this._edit) this._edit(prefill); }
    focus() { let f = this.folder; while (f && f.parent) { if (f.expanded === false) f.expanded = true; f = f.parent; } const t = this.element.querySelector('.lab-widget[tabindex], .lab-widget input, .lab-widget select, input'); if (t) { t.focus({ preventScroll: false }); t.scrollIntoView && t.scrollIntoView({ block: 'nearest' }); } return t; }
    serialise() { return cloneV(this.obj[this.key]); }
  }
  Binding.views = {};

  // number slider (Blender-style): drag to scrub, click to type, arrows to nudge
  Binding.views.slider = function (row, o) {
    const min = o.min, max = o.max;
    const hasRange = typeof min === 'number' && typeof max === 'number' && max > min;
    const step = o.step != null ? o.step : (hasRange ? (max - min) / 100 : 1);
    const isInt = decimals(step) === 0;
    const w = el('div', 'lab-widget lab-num' + (isInt ? ' lab-int' : ''));
    const fill = el('div', 'lab-fill');
    const val = el('div', 'lab-val');
    const input = el('input'); input.type = 'text'; input.spellcheck = false;
    w.append(fill, val, input); row.appendChild(w);
    w.tabIndex = 0;
    const read = () => {
      let v = +this.obj[this.key]; if (!isFinite(v)) v = 0;
      return v;
    };
    const snap = (v) => {
      if (hasRange) v = clamp(v, min, max);
      if (step > 0 && isFinite(step)) v = Math.round(v / step) * step;
      return +v.toFixed(Math.min(10, decimals(step) + 2));
    };
    const paint = () => {
      const v = read();
      val.textContent = '';
      val.appendChild(el('span', null, (o.format ? o.format(v) : fmt(v, step, o.unit))));
      fill.style.width = hasRange ? (((v - min) / (max - min)) * 100).toFixed(2) + '%' : '0%';
    };
    this.refresh = paint;
    paint();
    const mult = (e) => e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    this._nudge = (dir, m) => this._commit(snap(read() + dir * step * (m || 1)), true);
    if (o.readonly) { w.classList.add('lab-disabled'); return; }

    // drag
    let drag = null;
    w.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || w.classList.contains('editing')) return;
      drag = { x: e.clientX, v: read(), moved: false, onLabel: !!(e.target.closest && e.target.closest('.lab-in')) };
      w.setPointerCapture(e.pointerId);
    });
    w.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 3) return;
      drag.moved = true;
      const width = Math.max(60, w.clientWidth);
      const span = hasRange ? (max - min) : Math.max(Math.abs(drag.v), 1) * 2;
      const fine = e.altKey ? 0.1 : e.shiftKey ? 3 : 1;   // alt = fine, shift = coarse
      const v = snap(drag.v + (dx / width) * span * fine);
      if (v !== read()) this._commit(v, false);
    });
    const endDrag = (e) => {
      if (!drag) return;
      const moved = drag.moved, onLabel = drag.onLabel; drag = null;
      try { w.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved) this._commit(read(), true);
      else if (!onLabel) beginEdit();
    };
    w.addEventListener('pointerup', endDrag);
    w.addEventListener('pointercancel', () => { drag = null; });
    // wheel nudges (only while hovered and focused, to not fight scroll)
    w.addEventListener('wheel', (e) => {
      if (doc.activeElement !== w) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      this._commit(snap(read() + dir * step * (e.shiftKey ? 10 : 1)), true);
    }, { passive: false });
    w.addEventListener('keydown', (e) => {
      if (w.classList.contains('editing')) return;
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); this._nudge(-1, mult(e)); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); this._nudge(1, mult(e)); }
      else if (e.key === 'Enter') { e.preventDefault(); beginEdit(); }
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); this.reset(); }
      else if (/^[-+*/.\d]$/.test(e.key)) { e.preventDefault(); beginEdit(e.key); }
    });
    const beginEdit = (prefill) => {
      w.classList.add('editing');
      input.value = prefill != null ? prefill : String(read());
      input.focus(); if (prefill != null) input.setSelectionRange(input.value.length, input.value.length); else input.select();
    };
    this._edit = beginEdit;
    const endEdit = (apply) => {
      if (!w.classList.contains('editing')) return;
      w.classList.remove('editing');
      if (apply) {
        let txt = input.value.trim().replace(',', '.');
        let v = NaN;
        try {
          if (/^[-+*/().\d\s%]+$/.test(txt)) {
            const cur = read();
            if (/^[*/+]/.test(txt)) txt = '(' + cur + ')' + txt;                               // *2, /3, +0.1 are relative
            if (/%$/.test(txt) && hasRange) v = min + (Function('"use strict";return (' + txt.replace(/%$/, '') + ')')() / 100) * (max - min);   // 50% of the range
            else v = Function('"use strict";return (' + txt.replace(/%/g, '/100') + ')')();
          }
        } catch (_) {}
        if (isFinite(v)) this._commit(snap(+v), true);
      }
      w.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); endEdit(true); }
      if (e.key === 'Escape') { e.preventDefault(); endEdit(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => endEdit(true));
  };

  Binding.views.list = function (row, o) {
    const w = el('div', 'lab-widget lab-select');
    const s = el('select');
    const opts = normalizeOptions(o.options);
    opts.forEach(({ text, value }) => { const op = el('option', null, text); op.value = String(value); s.appendChild(op); });
    w.appendChild(s); row.appendChild(w);
    const typed = (str) => {
      const hit = opts.find((x) => String(x.value) === str);
      return hit ? hit.value : str;
    };
    this.refresh = () => { s.value = String(this.obj[this.key]); };
    this.refresh();
    s.addEventListener('change', () => this._commit(typed(s.value), true));
    this._nudge = (dir) => { const i = opts.findIndex((x) => String(x.value) === String(this.obj[this.key])); const j = clamp(i + dir, 0, opts.length - 1); if (j !== i) this._commit(opts[j].value, true); };
    s.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); this._nudge(e.key === 'ArrowLeft' ? -1 : 1); } });
    this.setOptions = (next) => {
      s.textContent = '';
      opts.length = 0; normalizeOptions(next).forEach((x) => opts.push(x));
      opts.forEach(({ text, value }) => { const op = el('option', null, text); op.value = String(value); s.appendChild(op); });
      this.refresh();
    };
    if (o.readonly) s.disabled = true;
  };

  Binding.views.checkbox = function (row, o) {
    row.classList.add('lab-check-row');
    const lab = el('label', 'lab-check');
    const i = el('input'); i.type = 'checkbox';
    const box = el('span', 'lab-box');
    lab.append(i, box); row.appendChild(lab);
    this.refresh = () => { i.checked = !!this.obj[this.key]; };
    this.refresh();
    i.addEventListener('change', () => this._commit(i.checked, true));
    row.querySelector('label').addEventListener('click', () => { if (!o.readonly) { i.checked = !i.checked; this._commit(i.checked, true); } });
    if (o.readonly) i.disabled = true;
  };

  Binding.views.color = function (row, o) {
    const w = el('div', 'lab-widget lab-color');
    const i = el('input'); i.type = 'color';
    const hex = el('span', 'lab-hex');
    w.append(i, hex); row.appendChild(w);
    this.refresh = () => { const v = String(this.obj[this.key] || '#000000'); i.value = v.length === 7 ? v : '#000000'; hex.textContent = v.toUpperCase(); };
    this.refresh();
    i.addEventListener('input', () => this._commit(i.value, false));
    i.addEventListener('change', () => this._commit(i.value, true));
    if (o.readonly) i.disabled = true;
  };

  Binding.views.text = function (row, o) {
    const w = el('div', 'lab-widget lab-text');
    const i = el('input'); i.type = 'text'; i.spellcheck = false;
    if (o.placeholder) i.placeholder = o.placeholder;
    w.appendChild(i); row.appendChild(w);
    this.refresh = () => { if (doc.activeElement !== i) i.value = this.obj[this.key] == null ? '' : String(this.obj[this.key]); };
    this.refresh();
    i.addEventListener('input', () => this._commit(i.value, false));
    i.addEventListener('change', () => this._commit(i.value, true));
    i.addEventListener('keydown', (e) => e.stopPropagation());
    if (o.readonly) i.readOnly = true;
  };

  Binding.views.textarea = function (row, o) {
    row.classList.add('lab-full');
    const w = el('div', 'lab-widget lab-text lab-multi');
    const i = el('textarea'); i.rows = o.rows || 2; i.spellcheck = false;
    if (o.placeholder) i.placeholder = o.placeholder;
    w.appendChild(i); row.appendChild(w);
    this._label.hidden = !o.label;
    if (o.label) row.classList.remove('lab-full');
    this.refresh = () => { if (doc.activeElement !== i) i.value = this.obj[this.key] == null ? '' : String(this.obj[this.key]); };
    this.refresh();
    i.addEventListener('input', () => this._commit(i.value, false));
    i.addEventListener('change', () => this._commit(i.value, true));
    i.addEventListener('keydown', (e) => e.stopPropagation());
  };

  // readonly monitor: samples obj[key] on an interval and draws a line
  Binding.views.graph = function (row, o) {
    const w = el('div', 'lab-widget lab-graph');
    const c = el('canvas'); w.appendChild(c); row.appendChild(w);
    const min = o.min != null ? o.min : 0, max = o.max != null ? o.max : 1;
    const n = o.samples || 64, hist = new Float32Array(n); let head = 0;
    const ctx = c.getContext('2d');
    const draw = () => {
      const r = w.getBoundingClientRect();
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
      const W = c.width, H = c.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = getComputedStyle(w).getPropertyValue('--lab-bg-3') || '#2e2e2e'; ctx.fillRect(0, 0, W, H);
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = hist[(head + i) % n];
        const x = (i / (n - 1)) * W, y = H - ((clamp(v, min, max) - min) / (max - min)) * (H - 2) - 1;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.lineWidth = dpr; ctx.strokeStyle = '#4f7cc4'; ctx.stroke();
    };
    const tick = () => {
      const v = +this.obj[this.key]; hist[head] = isFinite(v) ? v : 0; head = (head + 1) % n;
      if (!this.element.hidden && w.isConnected) draw();
    };
    this._timer = setInterval(tick, o.interval || 60);
    this.refresh = draw;
    const disp = this.dispose.bind(this);
    this.dispose = () => { clearInterval(this._timer); disp(); };
  };

  function normalizeOptions(options) {
    if (!options) return [];
    if (Array.isArray(options)) {
      return options.map((x) => Array.isArray(x) ? { value: x[0], text: x[1] } : (typeof x === 'object' ? x : { value: x, text: String(x) }));
    }
    return Object.keys(options).map((k) => ({ text: k, value: options[k] }));
  }

  // ---------------------------------------------------------------- simple controls
  class ButtonControl extends Control {
    constructor(parent, o) {
      const row = el('div', 'lab-row lab-full');
      super(parent, row);
      const b = el('button', 'lab-btn' + (o.accent ? ' lab-accent' : '') + (o.danger ? ' lab-danger' : '') + (o.rec ? ' lab-rec' : '') + (o.tall ? ' lab-tall' : ''), o.title);
      if (o.id) b.id = o.id;
      b.type = 'button';
      row.appendChild(b);
      this.button = b;
      b.addEventListener('click', (e) => this.emit('click', { native: e, target: this }));
      if (o.onClick) this.on('click', o.onClick);
    }
    get title() { return this.button.textContent; }
    set title(t) { this.button.textContent = t; }
    get on_() { return this.button.classList.contains('on'); }
    set active(v) { this.button.classList.toggle('on', !!v); this.button.setAttribute('aria-pressed', v ? 'true' : 'false'); }
    get active() { return this.button.classList.contains('on'); }
    set disabled(v) { this._disabled = !!v; this.button.disabled = !!v; }
    get disabled() { return this._disabled; }
  }

  class ButtonsControl extends Control {
    constructor(parent, items, o) {
      o = o || {};
      const row = el('div', 'lab-row' + (o.label ? '' : ' lab-full'));
      super(parent, row);
      if (o.label) row.appendChild(el('label', null, o.label));
      const box = el('div', 'lab-btns' + (o.cols ? ' lab-grid-' + o.cols : '') + (o.nowrap ? ' lab-nowrap' : ''));
      row.appendChild(box);
      this.buttons = {};
      items.forEach((it) => {
        if (typeof it === 'string') it = { title: it };
        const b = el('button', 'lab-btn' + (it.accent ? ' lab-accent' : '') + (it.danger ? ' lab-danger' : '') + (it.rec ? ' lab-rec' : '') + (it.icon ? ' lab-icon' : ''), it.title);
        b.type = 'button';
        if (it.id) b.id = it.id;
        if (it.key) this.buttons[it.key] = b;
        if (it.title_) b.title = it.title_;
        if (it.flex) b.style.flex = it.flex;
        b.addEventListener('click', (e) => { if (it.onClick) it.onClick(e, b); this.emit('click', { key: it.key, button: b, native: e }); });
        box.appendChild(b);
      });
      this.box = box;
    }
  }


  // XY pad: two numeric keys on one surface. addPad(obj, xKey, yKey, {xmin,xmax,ymin,ymax,xLabel,yLabel,label,onChange})
  class PadControl extends Control {
    constructor(parent, obj, xKey, yKey, o) {
      o = o || {};
      const row = el('div', o.half ? 'lab-row lab-half' : 'lab-row lab-full');   // half: one column of a cols:2 body
      super(parent, row);
      this.obj = obj; this.xKey = xKey; this.yKey = yKey; this.opts = o;
      const pad = el('div', 'lab-pad'); row.appendChild(pad);
      const h = el('i', 'lab-pad-h'), v = el('i', 'lab-pad-v'), dot = el('i', 'lab-pad-dot');
      const ax = el('span', 'lab-pad-ax lab-pad-x', o.xLabel || xKey), ay = el('span', 'lab-pad-ax lab-pad-y', o.yLabel || yKey), rd = el('span', 'lab-pad-rd');
      pad.append(h, v, dot, ay, ax, rd);
      if (o.label) { const t = el('span', 'lab-pad-title', o.label); pad.appendChild(t); }
      const xr = [o.xmin != null ? o.xmin : 0, o.xmax != null ? o.xmax : 1], yr = [o.ymin != null ? o.ymin : 0, o.ymax != null ? o.ymax : 1];
      const xd = o.xDigits != null ? o.xDigits : 2, yd = o.yDigits != null ? o.yDigits : 2;
      const nx = () => clamp((+obj[xKey] - xr[0]) / (xr[1] - xr[0]), 0, 1), ny = () => clamp((+obj[yKey] - yr[0]) / (yr[1] - yr[0]), 0, 1);
      this.refresh = () => { const x = nx() * 100, y = (1 - ny()) * 100; v.style.left = x + '%'; h.style.top = y + '%'; dot.style.left = x + '%'; dot.style.top = y + '%'; rd.textContent = (+obj[xKey]).toFixed(xd) + ' · ' + (+obj[yKey]).toFixed(yd); };
      this.refresh();
      this.default = o.reset ? o.reset.slice() : [obj[xKey], obj[yKey]];
      const paths = () => { const pn = this.pane; const r = pn && pn._rootName(obj); return r ? [r + '.' + xKey, r + '.' + yKey] : [null, null]; };
      const write = (x, y, last) => {
        const bx = obj[xKey], by = obj[yKey];
        obj[xKey] = +x.toFixed(6); obj[yKey] = +y.toFixed(6); this.refresh();
        this.emit('change', { value: [obj[xKey], obj[yKey]], last, target: this });
        if (o.onChange) o.onChange(obj[xKey], obj[yKey], last);
        this._record(paths(), [bx, by], [obj[xKey], obj[yKey]], last);
      };
      const set = (e, last) => {
        const r = pad.getBoundingClientRect();
        const fx = clamp((e.clientX - r.left) / r.width, 0, 1), fy = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
        let x = xr[0] + fx * (xr[1] - xr[0]), y = yr[0] + fy * (yr[1] - yr[0]);
        if (o.xStep) x = Math.round(x / o.xStep) * o.xStep; if (o.yStep) y = Math.round(y / o.yStep) * o.yStep;
        write(x, y, last);
      };
      pad.tabIndex = 0;
      pad.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; pad.focus(); pad.setPointerCapture(e.pointerId); pad.classList.add('drag'); set(e, false); e.preventDefault(); });
      pad.addEventListener('pointermove', (e) => { if (pad.classList.contains('drag')) set(e, false); });
      const up = (e) => { if (!pad.classList.contains('drag')) return; pad.classList.remove('drag'); set(e, true); };
      pad.addEventListener('pointerup', up); pad.addEventListener('pointercancel', up);
      this.reset = () => { const d = this.default; if (d && (obj[xKey] !== d[0] || obj[yKey] !== d[1])) write(d[0], d[1], true); };
      pad.addEventListener('dblclick', (e) => { if (e.altKey && this.folder) this.folder.resetAll(); else this.reset(); });
      this.nudge = (dx, dy, m) => { const sx = o.xStep || (xr[1] - xr[0]) / 100, sy = o.yStep || (yr[1] - yr[0]) / 100; write(clamp(+obj[xKey] + dx * sx * (m || 1), xr[0], xr[1]), clamp(+obj[yKey] + dy * sy * (m || 1), yr[0], yr[1]), true); };
      pad.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey) return;
        const m = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
        if (e.key === 'ArrowLeft') { e.preventDefault(); this.nudge(-1, 0, m); } else if (e.key === 'ArrowRight') { e.preventDefault(); this.nudge(1, 0, m); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); this.nudge(0, -1, m); } else if (e.key === 'ArrowUp') { e.preventDefault(); this.nudge(0, 1, m); }
        else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); this.reset(); }
      });
      this.pad = pad;
    }
    get path() { const pn = this.pane; const r = pn && pn._rootName(this.obj); return r ? r + '.' + this.xKey : null; }
    statePaths() { const pn = this.pane; const r = pn && pn._rootName(this.obj); return r ? [r + '.' + this.xKey, r + '.' + this.yKey] : []; }
  }

  // Curve: a live function graph. addCurve(obj, {fn:(x, obj)=>y | [y...], xKey, yKey, xmin..ymax, xLabel, yLabel, label, half, samples, onChange})
  // fn maps x in 0..1 to y in 0..1 (or an array of ys for several traces). With xKey / yKey the surface drags like a pad.
  class CurveControl extends Control {
    constructor(parent, obj, o) {
      o = o || {};
      const row = el('div', o.half ? 'lab-row lab-half' : 'lab-row lab-full');
      super(parent, row);
      this.obj = obj; this.opts = o;
      const pad = el('div', 'lab-pad lab-curve'); row.appendChild(pad);
      const cv = document.createElement('canvas'); cv.className = 'lab-curve-cv'; pad.appendChild(cv);
      const ax = el('span', 'lab-pad-ax lab-pad-x', o.xLabel || ''), ay = el('span', 'lab-pad-ax lab-pad-y', o.yLabel || ''), rd = el('span', 'lab-pad-rd');
      pad.append(ay, ax, rd);
      if (o.label) pad.appendChild(el('span', 'lab-pad-title', o.label));
      const xr = [o.xmin != null ? o.xmin : 0, o.xmax != null ? o.xmax : 1], yr = [o.ymin != null ? o.ymin : 0, o.ymax != null ? o.ymax : 1];
      const xd = o.xDigits != null ? o.xDigits : 2, yd = o.yDigits != null ? o.yDigits : 2;
      const N = o.samples || 64;
      const draggable = !!(o.xKey || o.yKey);
      if (!draggable) pad.classList.add('lab-curve-ro');
      const draw = () => {
        const w = pad.clientWidth, h = pad.clientHeight; if (!w || !h) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
        const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
        g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
        for (let i = 1; i < 4; i++) { const x = Math.round(w * i / 4) + .5, y = Math.round(h * i / 4) + .5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
        const cols = ['rgba(120,170,255,.95)', 'rgba(255,150,70,.9)', 'rgba(120,230,160,.9)'];
        const traces = [];
        for (let i = 0; i <= N; i++) { let v = o.fn(i / N, obj); if (!Array.isArray(v)) v = [v]; v.forEach((y, k) => { (traces[k] = traces[k] || []).push(y); }); }
        traces.forEach((tr, k) => {
          g.strokeStyle = cols[k % cols.length]; g.lineWidth = 1.5; g.beginPath();
          tr.forEach((y, i) => { const px = i / N * (w - 2) + 1, py = (1 - clamp(+y || 0, 0, 1)) * (h - 2) + 1; if (i) g.lineTo(px, py); else g.moveTo(px, py); });
          g.stroke();
          if (k === 0) { g.lineTo(w - 1, h - 1); g.lineTo(1, h - 1); g.closePath(); g.fillStyle = 'rgba(61,125,220,.12)'; g.fill(); }
        });
        if (draggable) {
          const nx = o.xKey ? clamp((+obj[o.xKey] - xr[0]) / (xr[1] - xr[0]), 0, 1) : null;
          const ny = o.yKey ? clamp((+obj[o.yKey] - yr[0]) / (yr[1] - yr[0]), 0, 1) : null;
          g.strokeStyle = 'rgba(61,125,220,.55)';
          if (nx != null) { const x = Math.round(nx * w) + .5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
          if (ny != null) { const y = Math.round((1 - ny) * h) + .5; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
          const parts = []; if (o.xKey) parts.push((+obj[o.xKey]).toFixed(xd)); if (o.yKey) parts.push((+obj[o.yKey]).toFixed(yd));
          rd.textContent = parts.join(' · ');
        } else if (o.readout) rd.textContent = o.readout(obj);
      };
      this.refresh = draw;
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(draw).observe(pad);
      let root = parent; while (root && root.parent) root = root.parent;
      if (root && root.on) root.on('change', () => draw());
      if (draggable) {
        const set = (e, last) => {
          const r = pad.getBoundingClientRect();
          const fx = clamp((e.clientX - r.left) / r.width, 0, 1), fy = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
          const keys_ = [o.xKey, o.yKey].filter(Boolean), befores = keys_.map((k) => obj[k]);
          if (o.xKey) { let x = xr[0] + fx * (xr[1] - xr[0]); if (o.xStep) x = Math.round(x / o.xStep) * o.xStep; obj[o.xKey] = +x.toFixed(6); }
          if (o.yKey) { let y = yr[0] + fy * (yr[1] - yr[0]); if (o.yStep) y = Math.round(y / o.yStep) * o.yStep; obj[o.yKey] = +y.toFixed(6); }
          draw();
          const value = [o.xKey ? obj[o.xKey] : null, o.yKey ? obj[o.yKey] : null];
          this.emit('change', { value, last, target: this });
          if (o.onChange) o.onChange(value[0], value[1], last);
          const pn = this.pane, rn = pn && pn._rootName(obj);
          this._record(keys_.map((k) => rn ? rn + '.' + k : null), befores, keys_.map((k) => obj[k]), last);
        };
        pad.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; pad.setPointerCapture(e.pointerId); pad.classList.add('drag'); set(e, false); e.preventDefault(); });
        pad.addEventListener('pointermove', (e) => { if (pad.classList.contains('drag')) set(e, false); });
        const up = (e) => { if (!pad.classList.contains('drag')) return; pad.classList.remove('drag'); set(e, true); };
        pad.addEventListener('pointerup', up); pad.addEventListener('pointercancel', up);
      }
      this.pad = pad;
      requestAnimationFrame(draw);
    }
    get path() { const pn = this.pane; const r = pn && pn._rootName(this.obj); const k = this.opts.yKey || this.opts.xKey; return r && k ? r + '.' + k : null; }
    statePaths() { const pn = this.pane; const r = pn && pn._rootName(this.obj); return r ? [this.opts.xKey, this.opts.yKey].filter(Boolean).map((k) => r + '.' + k) : []; }
  }

  class PresetsControl extends Control {
    constructor(parent, names, o) {
      o = o || {};
      const row = el('div', 'lab-row lab-full');
      super(parent, row);
      const thumbs = o.thumbs;   // true: a canvas per preset the tool paints; {name: url}: static images
      const grid = el('div', 'lab-presets' + (o.cols ? ' lab-cols-' + o.cols : '') + (thumbs ? ' lab-thumbs' : ''));
      if (thumbs && o.aspect) grid.style.setProperty('--lab-thumb-aspect', o.aspect);
      row.appendChild(grid);
      this.grid = grid; this.buttons = {}; this.thumbs = {};
      names.forEach((name) => {
        const label = o.format ? o.format(name) : name;
        const b = el('button', 'lab-btn' + (thumbs ? ' lab-thumb' : ''), thumbs ? '' : label); b.type = 'button'; b.title = label;
        if (thumbs) {
          const src = typeof thumbs === 'object' ? thumbs[name] : null;
          const img = src ? el('img', 'lab-thumb-img') : el('canvas', 'lab-thumb-img');
          if (src) { img.src = src; img.alt = ''; img.loading = 'lazy'; img.draggable = false; }
          else { img.width = o.thumbWidth || 160; img.height = o.thumbHeight || 90; }
          b.append(img, el('span', 'lab-thumb-cap', label));
          this.thumbs[name] = img;
        }
        b.addEventListener('click', () => { this.select(name); this.emit('select', { name, target: this }); if (o.onSelect) o.onSelect(name); });
        this.buttons[name] = b; grid.appendChild(b);
      });
      if (o.value) this.select(o.value);
    }
    select(name) { Object.keys(this.buttons).forEach((k) => this.buttons[k].classList.toggle('on', k === name)); this.current = name; }
    clear() { this.select(null); }
    // paint every canvas thumbnail: fn(name, canvas)
    render(fn) { Object.keys(this.thumbs).forEach((name) => { const t = this.thumbs[name]; if (t.tagName === 'CANVAS') fn(name, t); }); }
    setThumb(name, src) { const t = this.thumbs[name]; if (!t) return; if (t.tagName === 'IMG') t.src = src; else { const i = new Image(); i.onload = () => t.getContext('2d').drawImage(i, 0, 0, t.width, t.height); i.src = src; } }
  }

  class StatusControl extends Control {
    constructor(parent, text, o) {
      o = o || {};
      const n = el('div', 'lab-status-line');
      if (o.id) n.id = o.id;
      super(parent, n);
      this.set(text || '', o.kind);
    }
    set(text, kind) {
      this.element.textContent = text == null ? '' : text;
      this.element.className = 'lab-status-line' + (kind ? ' ' + kind : '');
      this.element.hidden = !text && !!this.opts_hideEmpty;
    }
  }

  class ProgressControl extends Control {
    constructor(parent, o) {
      o = o || {};
      const n = el('div', 'lab-progress'); const bar = el('i'); n.appendChild(bar);
      if (o.id) bar.id = o.id;
      super(parent, n);
      this.bar = bar;
    }
    set(p) { this.bar.style.width = (clamp(+p || 0, 0, 1) * 100).toFixed(1) + '%'; }
  }

  class NoteControl extends Control {
    constructor(parent, html, o) {
      const n = el('div', 'lab-note'); n.innerHTML = html; super(parent, n);
    }
  }
  class SeparatorControl extends Control {
    constructor(parent) { super(parent, el('div', 'lab-sep')); }
  }
  class SubheadControl extends Control {
    constructor(parent, text) { super(parent, el('div', 'lab-sub', text)); }
  }
  class RawControl extends Control {
    constructor(parent, node) { super(parent, node); }
  }

  // ---------------------------------------------------------------- folder / pane
  class Folder extends Emitter {
    constructor(parent, o) {
      super();
      o = o || {};
      this.parent = parent;
      this._children = [];
      this.element = el('section', 'lab-panel' + (o.expanded === false ? ' collapsed' : ''));
      if (o.id) this.element.id = o.id;
      const head = el('div', 'lab-panel-head');
      head.append(el('span', 'lab-chev'), el('span', 'lab-title', o.title || ''));
      const right = el('span', 'lab-head-right'); head.appendChild(right);
      this.head = head; this.headRight = right; head._labWired = true; // enhance() must not bind a second toggle
      this.body = el('div', 'lab-panel-body' + (o.cols ? ' lab-cols-' + o.cols : ''));
      this.element.append(head, this.body);
      head.addEventListener('click', (e) => { if (e.target.closest('.lab-head-right')) return; this.expanded = !this.expanded; });
      this._badge = null;
    }
    get expanded() { return !this.element.classList.contains('collapsed'); }
    set expanded(v) { this.element.classList.toggle('collapsed', !v); this.emit('fold', { expanded: !!v }); }
    get title() { return this.head.querySelector('.lab-title').textContent; }
    set title(t) { this.head.querySelector('.lab-title').textContent = t; }
    get hidden() { return this.element.hidden; }
    set hidden(v) { this.element.hidden = !!v; }
    badge(text) {
      if (!this._badge) { this._badge = el('span', 'lab-badge'); this.headRight.appendChild(this._badge); }
      this._badge.textContent = text == null ? '' : text; this._badge.hidden = text == null || text === '';
      return this;
    }
    _add(ctrl) { this._children.push(ctrl); this.body.appendChild(ctrl.element); return ctrl; }
    addBinding(obj, key, o) { const b = this._add(new Binding(this, obj, key, o)); b.on('change', (ev) => this._bubble(ev)); return b; }
    addButton(o) { return this._add(new ButtonControl(this, o || {})); }
    addButtons(items, o) { return this._add(new ButtonsControl(this, items, o)); }
    addBlade(o) {
      o = o || {};
      if (o.view === 'list') {
        const holder = { v: o.value };
        const b = this.addBinding(holder, 'v', { label: o.label, options: o.options, view: 'list' });
        return b;
      }
      if (o.view === 'separator') return this.addSeparator();
      if (o.view === 'text') { const holder = { v: o.value }; return this.addBinding(holder, 'v', { label: o.label, view: 'text' }); }
      return this.addNote(o.text || '');
    }
    addPresets(names, o) { return this._add(new PresetsControl(this, names, o)); }
    addPad(obj, xKey, yKey, o) { return this._add(new PadControl(this, obj, xKey, yKey, o)); }
    addCurve(obj, o) { const c = this._add(new CurveControl(this, obj, o)); c.on('change', (ev) => this._bubble(ev)); return c; }
    addStatus(text, o) { return this._add(new StatusControl(this, text, o)); }
    addProgress(o) { return this._add(new ProgressControl(this, o)); }
    addNote(html) { return this._add(new NoteControl(this, html)); }
    addSeparator() { return this._add(new SeparatorControl(this)); }
    addSubhead(text) { return this._add(new SubheadControl(this, text)); }
    addElement(node) { return this._add(new RawControl(this, node)); }
    addFolder(o) { const f = new Folder(this, o); this._children.push(f); this.body.appendChild(f.element); f.on('change', (ev) => this._bubble(ev)); f.on('fold', (ev) => this.emit('fold', ev)); return f; }
    _bubble(ev) { this.emit('change', ev); }
    refresh() { this._children.forEach((c) => c.refresh && c.refresh()); }
    dispose() { this.element.remove(); }
    get children() { return this._children.slice(); }
    // every Binding below this folder, depth first
    bindings() { const out = []; const walk = (f) => f._children.forEach((c) => { if (c instanceof Binding) out.push(c); else if (c instanceof Folder) walk(c); }); walk(this); return out; }
    folders() { const out = []; const walk = (f) => f._children.forEach((c) => { if (c instanceof Folder) { out.push(c); walk(c); } }); walk(this); return out; }
    // reset every tracked binding in the folder to its default, as one history entry
    resetAll() {
      const pn = this.pane; if (!pn) return;
      const flat = {}; this.bindings().forEach((b) => { if (b.path && b.default !== undefined) flat[b.path] = cloneV(b.default); });
      pn.setState(nest(flat), { label: 'Reset ' + (this.title || 'folder'), source: 'reset' });
    }
    get pane() { let p = this; while (p && p.parent) p = p.parent; return p && p.getState ? p : null; }
  }

  class Pane extends Folder {
    constructor(o) {
      o = o || {};
      super(null, { title: o.title });
      // a pane is a bare container, not a collapsible section
      this.element = el('div', 'lab-pane');
      this.body = this.element;
      const container = o.container ? (typeof o.container === 'string' ? doc.querySelector(o.container) : o.container) : null;
      if (container) container.appendChild(this.element);
      this._roots = [];
      this.replay = o.replay !== false;
      this.history = new History(this, o.history || {});
      keys.bind('KeyZ', 'mod', () => this.history.undo(), { label: 'Undo' });
      keys.bind('KeyZ', 'mod+shift', () => this.history.redo(), { label: 'Redo' });
      keys.bind('KeyY', 'ctrl', () => this.history.redo(), { label: 'Redo' });
      this.element.addEventListener('focusin', (e) => { this._focusEl = e.target; });
      this.on('state', (ev) => { if (ev.paths.some((p) => p.startsWith('bypass.'))) this._syncBypassUI(); });
      this.on('change', (ev) => { if (!ev || !ev.target || ev.last === false || ev.programmatic) return; const ps = (ev.target.statePaths ? ev.target.statePaths() : [ev.target.path]).filter(Boolean); if (ps.length) this._emitPaths(ps, 'control'); });
    }
    get expanded() { return true; }
    set expanded(v) {}
    get pane() { return this; }
    // declare a state root: primitive keys of obj (at call time, plus include, minus exclude) are tracked
    track(name, obj, o) {
      o = o || {};
      const ex = new Set(o.exclude || []);
      const ks = Object.keys(obj).filter((k) => !ex.has(k) && isPrim(obj[k])).concat((o.include || []).filter((k) => !ex.has(k)));
      const r = { name, obj, keys: [...new Set(ks)], defaults: {} };
      r.keys.forEach((k) => { r.defaults[k] = cloneV(obj[k]); });
      this._roots = this._roots.filter((x) => x.name !== name).concat([r]);
      return this;
    }
    untrack(name) { this._roots = this._roots.filter((x) => x.name !== name); }
    _rootName(obj) { const r = this._roots.find((x) => x.obj === obj); return r ? r.name : null; }
    root(name) { return this._roots.find((x) => x.name === name) || null; }
    getState() { const s = {}; this._roots.forEach((r) => { const o = {}; r.keys.forEach((k) => { o[k] = cloneV(r.obj[k]); }); s[r.name] = o; }); return s; }
    getDefaults() { const s = {}; this._roots.forEach((r) => { s[r.name] = cloneV(r.defaults); }); return s; }
    // apply a (partial) state: {root: {key: value}}; one history entry unless noHistory; emits 'state' with the changed paths
    setState(state, o) {
      o = o || {};
      const before = {}, after = {}, paths = [];
      this._roots.forEach((r) => {
        const part = state && state[r.name]; if (!part) return;
        r.keys.forEach((k) => { if (!(k in part)) return; const v = part[k]; if (r.obj[k] === v) return; paths.push(r.name + '.' + k); before[r.name + '.' + k] = cloneV(r.obj[k]); after[r.name + '.' + k] = cloneV(v); r.obj[k] = cloneV(v); });
      });
      if (!paths.length) return [];
      this.refresh();
      if (o.replay !== false && this.replay) this.bindings().forEach((b) => { const p = b.path; if (p && paths.includes(p)) b.emit('change', { value: b.value, last: true, target: b, programmatic: true, source: o.source || 'set' }); });
      if (!o.noHistory && this.history) this.history.push({ kind: o.kind || 'state', label: o.label || (paths.length === 1 ? this.history._label(paths, before, after) : paths.length + ' changes'), before, after, paths });
      this._emitPaths(paths, o.source || 'set');
      return paths;
    }
    _emitPaths(paths, source) { this.emit('state', { paths, source, keys: paths.map((p) => p.slice(p.indexOf('.') + 1)) }); }
    pathLabel(path) {
      if (!this._labels) { this._labels = {}; const walk = (f, t) => f._children.forEach((c) => { if (c instanceof Binding) { const p = c.path; if (p && !this._labels[p]) this._labels[p] = (t ? t + ' · ' : '') + c.label; } else if (c instanceof Folder) walk(c, c.title); }); walk(this, ''); }
      if (!(path in this._labels)) { if (!this._labelsRebuilt) { this._labelsRebuilt = true; this._labels = null; const r = this.pathLabel(path); this._labelsRebuilt = false; return r; } return path.slice(path.indexOf('.') + 1); }
      return this._labels[path];
    }
    getFolds() { const f = {}; this.folders().forEach((x) => { if (x.title) f[x.title] = x.expanded; }); return f; }
    setFolds(folds) { if (!folds) return; this.folders().forEach((x) => { if (x.title in folds && x.expanded !== !!folds[x.title]) x.element.classList.toggle('collapsed', !folds[x.title]); }); }
    addFolder(o) { const f = super.addFolder(o); f.on('fold', (ev) => this.emit('fold', ev)); return f; }
    addHistory(o) { return historyFolder(this, o); }
    focusedBinding() { const e = this._focusEl; if (!e || !e.isConnected) return null; return this.bindings().find((b) => b.element.contains(e)) || null; }
    focusedFolder() { const e = this._focusEl; if (!e || !e.isConnected) return null; let f = null; this.folders().forEach((x) => { if (x.element.contains(e) && (!f || f.element.contains(x.element))) f = x; }); return f; }
  }


  // ---------------------------------------------------------------- icons (24-grid line set)
  const ICONS = {
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 16-5-5-8 8"/>',
    webcam: '<circle cx="12" cy="10" r="5"/><circle cx="12" cy="10" r="1.6"/><path d="M8 20h8M12 15v5"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    testcard: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 12h18M9 4v16M15 4v16"/>',
    play: '<path d="M7 5v14l11-7z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    restart: '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v5h5"/>',
    record: '<circle cx="12" cy="12" r="8"/><circle class="lab-rec-dot" cx="12" cy="12" r="4"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    export: '<path d="M12 15V4M7 9l5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 17v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/>',
    save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-6h8v6"/>',
    front: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    reset: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
    fly: '<path d="M4 18c4 0 4-12 8-12s4 12 8 12"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="18" r="1.5"/>',
    audio: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>',
    dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="8.5" cy="8.5" r="1.2"/><circle cx="15.5" cy="8.5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="8.5" cy="15.5" r="1.2"/><circle cx="15.5" cy="15.5" r="1.2"/>',
    build: '<path d="M4 20h16M6 20V9l6-5 6 5v11"/><path d="M10 20v-5h4v5"/>',
    gif: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 10v4M11 10h2.5v4H11zM16 14v-4h2"/>',
    deselect: '<path d="M6 6l12 12M18 6 6 18"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    text: '<path d="M5 6h14M12 6v13M9 19h6"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    sample: '<path d="M4 9h16v11H4zM4 9l2-5h12l2 5M8 4l2 5M14 4l2 5"/>',
    fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
    ratio: '<rect x="3" y="6" width="18" height="12" rx="1"/><path d="M8 6v12M16 6v12"/>',
    layers: '<path d="m12 4 8 4-8 4-8-4z"/><path d="m4 12 8 4 8-4M4 16l8 4 8-4"/>',
    eye: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  };
  function icon(name) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || ICONS.grid;
    return svg;
  }

  // ---------------------------------------------------------------- tooltips
  let tipEl = null, tipTimer = null;
  function bindTip(btn, text, kbd) {
    if (!text) return;
    btn.setAttribute('aria-label', text);
    btn.addEventListener('pointerenter', () => {
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => {
        if (!tipEl) { tipEl = el('div', 'lab-tool-tip'); doc.body.appendChild(tipEl); }
        tipEl.textContent = text;
        if (kbd) tipEl.appendChild(el('span', 'lab-kbd', kbd));
        const r = btn.getBoundingClientRect();
        tipEl.style.left = Math.max(6, Math.min(r.left, global.innerWidth - 240)) + 'px';
        tipEl.style.top = (r.bottom + 6) + 'px';
        tipEl.hidden = false;
      }, 450);
    });
    const hide = () => { clearTimeout(tipTimer); if (tipEl) tipEl.hidden = true; };
    btn.addEventListener('pointerleave', hide); btn.addEventListener('pointerdown', hide);
  }

  // click: '#id' delegates to another element (keeps the tool's own ids in one place)
  function wireClick(btn, it) {
    if (it.onClick) btn.addEventListener('click', it.onClick);
    if (it.click) btn.addEventListener('click', () => { const t = doc.querySelector(it.click); if (t) t.click(); });
    if (it.toggleOf) btn.addEventListener('click', () => { const t = doc.querySelector(it.toggleOf); if (t) t.click(); });
  }

  // ---------------------------------------------------------------- menu bar with dropdowns
  // menus: [{ title, items: [{ title, icon, kbd, onClick, click:'#id', id, disabled } | { sep:true } | { head:'text' }] }]
  function menubar(container, menus) {
    let openItem = null;
    const closeAll = () => { if (openItem) { openItem.dd.hidden = true; openItem.btn.classList.remove('open'); openItem = null; } };
    doc.addEventListener('pointerdown', (e) => { if (openItem && !e.target.closest('.lab-menu-item')) closeAll(); });
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
    const built = [];
    (menus || []).forEach((m) => {
      const wrap = el('div', 'lab-menu-item');
      const btn = el('button', null, m.title); btn.type = 'button';
      if (m.id) btn.id = m.id;
      const dd = el('div', 'lab-dropdown'); dd.hidden = true;
      (m.items || []).forEach((it) => {
        if (it.sep) { dd.appendChild(el('hr')); return; }
        if (it.head) { dd.appendChild(el('div', 'lab-dd-head', it.head)); return; }
        const b = el('button'); b.type = 'button';
        if (it.icon) b.appendChild(icon(it.icon));
        b.appendChild(el('span', null, it.title));
        if (it.kbd) b.appendChild(el('span', 'lab-kbd', it.kbd));
        if (it.id) b.id = it.id;
        if (it.disabled) b.disabled = true;
        wireClick(b, it);
        b.addEventListener('click', closeAll);
        dd.appendChild(b);
      });
      const item = { btn, dd, menu: m };
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); if (openItem === item) { closeAll(); return; } closeAll(); dd.hidden = false; btn.classList.add('open'); openItem = item; });
      btn.addEventListener('pointerenter', () => { if (openItem && openItem !== item) { closeAll(); dd.hidden = false; btn.classList.add('open'); openItem = item; } });
      if (!m.items || !m.items.length) { wireClick(btn, m); }
      wrap.append(btn, dd); container.appendChild(wrap); built.push(item);
    });
    return built;
  }

  // ---------------------------------------------------------------- tool strip
  // groups: [[item, item], [item], ...] with item = { icon, title, text, tip, kbd, id, onClick, click:'#id',
  //   primary, rec, toggle } | { sep:true } | { spacer:true } | { label:'text' } | { el: node }
  const ICON_FAMILY = { folder:'amber', webcam:'amber', monitor:'amber', testcard:'amber', sample:'amber', camera:'amber', plus:'amber', image:'sky', save:'sky', download:'sky', gif:'sky', export:'sky',
    play:'green', pause:'green', restart:'green', bolt:'green', front:'cyan', reset:'cyan', fly:'cyan', fit:'cyan', eye:'cyan', ratio:'cyan',
    layers:'violet', grid:'violet', build:'violet', dice:'violet', text:'violet', audio:'pink', mic:'pink', undo:'red', deselect:'red', record:'red', film:'sky', link:'sky', menu:'sky' };
  function toolbar(container, groups) {
    container.textContent = '';
    const tools = {};
    const addItem = (it, into) => {
      if (it.sep) { into.appendChild(el('span', 'lab-tsep')); return; }
      if (it.spacer) { into.appendChild(el('span', 'lab-spacer')); return; }
      if (it.label) { into.appendChild(el('span', 'lab-tlabel', it.label)); return; }
      if (it.el) { into.appendChild(it.el); return; }
      const fam = it.c || (it.icon && ICON_FAMILY[it.icon]);
      const b = el('button', 'lab-tool' + (it.primary ? ' lab-primary' : '') + (it.rec ? ' lab-rec' : '') + (it.cls ? ' ' + it.cls : '') + (fam && !it.primary ? ' lab-c-' + fam : ''));
      b.type = 'button';
      if (it.icon) b.appendChild(icon(it.icon));
      if (it.text) b.appendChild(el('span', 'lab-tool-text', it.text));
      if (it.id) b.id = it.id;
      if (it.disabled) b.disabled = true;
      bindTip(b, it.tip || it.title, it.kbd);
      wireClick(b, it);
      if (it.toggle) b.addEventListener('click', () => { const on = !b.classList.contains('on'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); if (it.onToggle) it.onToggle(on, b); });
      if (it.key) tools[it.key] = b;
      into.appendChild(b);
    };
    (groups || []).forEach((g, gi) => {
      if (!Array.isArray(g)) { addItem(g, container); return; }
      const grp = el('div', 'lab-tgroup');
      g.forEach((it) => addItem(it, grp));
      container.appendChild(grp);
      const next = groups[gi + 1];
      if (next && Array.isArray(next)) container.appendChild(el('span', 'lab-tsep'));
    });
    return tools;
  }

  // ---------------------------------------------------------------- shell
  // shell({ root, title, subtitle, side:'right'|'left', wide, view:HTMLElement|null, menu:[{title,onClick}] })
  // Returns { shell, top, toolbar, side, sideHead, view, status, setStatus(items) }
  function shell(o) {
    o = o || {};
    const root = o.root ? (typeof o.root === 'string' ? doc.querySelector(o.root) : o.root) : doc.body;
    doc.documentElement.classList.add('lab-root');
    root.classList.add('lab');
    const s = el('div', 'lab-shell' + (o.side === 'left' ? ' lab-side-left' : '') + (o.wide ? ' lab-side-wide' : ''));
    const top = el('header', 'lab-top');
    const brand = el('div', 'lab-brand');
    brand.append(el('span', 'lab-mark'), el('b', null, o.title || ''));
    if (o.subtitle) brand.appendChild(el('span', null, o.subtitle));
    top.appendChild(brand);
    const menu = el('nav', 'lab-menu');
    menubar(menu, o.menus || o.menu || []);
    top.appendChild(menu);
    const tools = el('div', 'lab-tools');
    const toolRefs = toolbar(tools, o.tools || []);
    const tools2 = el('div', 'lab-tools2');
    if (o.tools2) Object.assign(toolRefs, toolbar(tools2, o.tools2)); else s.classList.add('lab-no-tools2');
    const rail = el('div', 'lab-rail');
    if (o.rail) Object.assign(toolRefs, toolbar(rail, o.rail)); else s.classList.add('lab-no-rail');
    top.appendChild(el('div', 'lab-spacer'));
    const tbar = el('div', 'lab-toolbar');
    top.appendChild(tbar);
    const view = el('main', 'lab-view');
    if (o.view) view.appendChild(o.view);
    const side = el('aside', 'lab-side');
    const sideHead = el('div', 'lab-side-head');
    if (o.sideHead !== false) side.appendChild(sideHead);
    const status = el('footer', 'lab-status');
    s.append(top, tools, tools2, rail, view, side, status);
    root.appendChild(s);
    const api = {
      shell: s, top, brand, menu, toolbar: tbar, tools, tools2, rail, tool: toolRefs, view, side, sideHead, status, keys, flash,
      setTools2(groups) { s.classList.remove('lab-no-tools2'); Object.assign(toolRefs, LabUI.toolbar(tools2, groups)); return toolRefs; },
      setRail(groups) { s.classList.remove('lab-no-rail'); Object.assign(toolRefs, LabUI.toolbar(rail, groups)); return toolRefs; },
      // document window chrome inside the viewport: title bar with lights, optional field bar, optional ruler
      doc(opts) {
        opts = opts || {};
        view.classList.add('lab-has-doc');
        let bar = view.querySelector('.lab-doc');
        if (!bar) {
          bar = el('div', 'lab-doc');
          const lights = el('span', 'lab-lights'); lights.append(el('i'), el('i'), el('i'));
          bar.append(lights, el('span', 'lab-doc-title'), el('span', 'lab-doc-right'));
          view.appendChild(bar);
        }
        if (opts.title != null) bar.querySelector('.lab-doc-title').textContent = opts.title;
        if (opts.right != null) bar.querySelector('.lab-doc-right').textContent = opts.right;
        let field = view.querySelector('.lab-docbar');
        if (opts.bar) {
          if (!field) { field = el('div', 'lab-docbar'); view.appendChild(field); view.classList.add('lab-has-docbar'); }
          field.textContent = '';
          toolbar(field, opts.bar);
        }
        let ruler = view.querySelector('.lab-ruler');
        if (opts.ruler !== false) {
          if (!ruler) { ruler = el('div', 'lab-ruler'); ruler.appendChild(el('canvas')); view.appendChild(ruler); }
          ruler.style.top = field ? '42px' : '20px';
          const draw = () => {
            const c = ruler.firstChild, r = ruler.getBoundingClientRect();
            const dpr = Math.min(2, global.devicePixelRatio || 1);
            c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
            const ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, r.width, r.height);
            if (opts.select) { ctx.fillStyle = 'rgba(47,95,209,.75)'; ctx.fillRect(opts.select[0], 0, Math.max(1, opts.select[1] - opts.select[0]), r.height); }
            ctx.strokeStyle = 'rgba(190,200,230,.55)'; ctx.fillStyle = '#d4dbf0'; ctx.font = '8px Monaco, Menlo, monospace';
            const unit = opts.unit || 50, origin = opts.origin || 0;
            for (let x = 0; x <= r.width; x += unit / 5) {
              const major = Math.round(x / unit) * unit === Math.round(x) || Math.abs((x % unit)) < 0.01;
              const h = major ? r.height : (Math.abs((x % (unit / 2))) < 0.01 ? r.height * .55 : r.height * .3);
              ctx.beginPath(); ctx.moveTo(x + .5, r.height); ctx.lineTo(x + .5, r.height - h); ctx.stroke();
              if (major && x > 0) ctx.fillText(String(Math.round(origin + x)), x + 2, 8);
            }
            if (opts.marker != null) { ctx.fillStyle = '#e8321f'; ctx.fillRect(opts.marker - 1, 0, 3, r.height); }
          };
          draw();
          if (!ruler._ro) { ruler._ro = new ResizeObserver(draw); ruler._ro.observe(ruler); }
          ruler._draw = draw;
        }
        let foot = view.querySelector('.lab-docfoot'), zoomApi = null;
        if (opts.zoom) {
          if (!foot) { foot = el('div', 'lab-docfoot'); view.appendChild(foot); view.classList.add('lab-has-docfoot'); }
          foot.textContent = '';
          const levels = Array.isArray(opts.zoom) ? opts.zoom : [25, 50, 75, 100, 120, 150, 200, 300, 400];
          const sel = el('div', 'lab-widget lab-select lab-zoom-sel'); const se = el('select');
          const opF = el('option', null, 'Fit'); opF.value = 'fit'; se.appendChild(opF);
          levels.forEach((z) => { const op = el('option', null, z + '%'); op.value = String(z); se.appendChild(op); });
          sel.appendChild(se);
          const minus = el('button', 'lab-tool', '−'), plus = el('button', 'lab-tool', '+'); minus.type = plus.type = 'button';
          const grp = el('div', 'lab-tgroup'); grp.append(minus, plus);
          const lab = el('span', 'lab-tlabel', 'view');
          foot.append(lab, sel, grp, el('span', 'lab-spacer'));
          if (opts.footRight) { const r = el('span', 'lab-foot-right', opts.footRight); foot.appendChild(r); foot._right = r; }
          let cur = 'fit';
          api._zoomSelect = se;
          const apply = (z) => {
            cur = z; se.value = String(z);
            const f = z === 'fit' ? 1 : z / 100;
            if (api.viewer && api.viewer.canvas) api.viewer.setZoom(z === 'fit' ? 'fit' : f);
            else { view.style.setProperty('--lab-zoom', String(f)); view.classList.toggle('lab-zoomed', f !== 1); }
            if (opts.onZoom) opts.onZoom(f, z);
          };
          se.addEventListener('change', () => apply(se.value === 'fit' ? 'fit' : +se.value));
          const step = (d) => { const i = cur === 'fit' ? levels.indexOf(100) : levels.indexOf(cur); const j = clamp(i + d, 0, levels.length - 1); apply(levels[j]); };
          minus.addEventListener('click', () => step(-1)); plus.addEventListener('click', () => step(1));
          apply(opts.zoomValue || 'fit');
          zoomApi = { setZoom: apply, getZoom: () => cur, foot, setFootRight: (t) => { if (foot._right) foot._right.textContent = t; } };
        }
        return Object.assign({ bar, field, ruler, setTitle: (t) => { bar.querySelector('.lab-doc-title').textContent = t; }, setRight: (t) => { bar.querySelector('.lab-doc-right').textContent = t; } }, zoomApi || {});
      },
      setTools(groups) { Object.assign(toolRefs, LabUI.toolbar(tools, groups)); return toolRefs; },
      setMenus(menus) { menu.textContent = ''; menubar(menu, menus); },
      // setStatus([{text, bold, dot:'ok'|'rec'|'warn', spacer}]) or a string
      setStatus(items) {
        status.textContent = '';
        if (typeof items === 'string') items = [{ text: items }];
        (items || []).forEach((it) => {
          if (it.spacer) { status.appendChild(el('span', 'lab-spacer')); return; }
          const span = el('span', it.cell ? 'lab-cell' : null);
          if (it.dot) span.appendChild(el('i', 'lab-dot ' + it.dot));
          if (it.bold) { span.appendChild(el('b', null, it.bold)); if (it.text) span.appendChild(doc.createTextNode(' ' + it.text)); }
          else span.appendChild(doc.createTextNode(it.text || ''));
          if (it.id) span.id = it.id;
          status.appendChild(span);
        });
      },
      hud(text) {
        let h = view.querySelector('.lab-hud');
        if (!h) { h = el('div', 'lab-hud'); view.appendChild(h); }
        if (text != null) h.innerHTML = text;
        return h;
      },
      hint(text) {
        let h = view.querySelector('.lab-hint');
        if (!h) { h = el('div', 'lab-hint'); view.appendChild(h); }
        if (text != null) h.innerHTML = text;
        return h;
      },
      drop(text) {
        let d = view.querySelector('.lab-drop');
        if (!d) { d = el('div', 'lab-drop'); view.appendChild(d); }
        if (text != null) d.textContent = text;
        return d;
      },
      toolbarButton(o2) {
        const b = el('button', 'lab-btn' + (o2.accent ? ' lab-accent' : '') + (o2.danger ? ' lab-danger' : '') + (o2.rec ? ' lab-rec' : ''), o2.title);
        b.type = 'button'; if (o2.id) b.id = o2.id; if (o2.onClick) b.addEventListener('click', o2.onClick);
        tbar.appendChild(b); return b;
      },
    };
    api.viewer = new Viewer(api);
    lastShell = api;
    return api;
  }

  // file drop helper: wires drag states on the viewport and returns files to the callback
  function dropTarget(target, onFiles, dropEl) {
    let depth = 0;
    const on = (v) => { target.classList.toggle('lab-dragging', v); if (dropEl) dropEl.classList.toggle('on', v); };
    doc.addEventListener('dragenter', (e) => { if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return; depth++; on(true); });
    doc.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) on(false); });
    doc.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    doc.addEventListener('drop', (e) => { depth = 0; on(false); if (!e.dataTransfer || !e.dataTransfer.files.length) return; e.preventDefault(); onFiles([...e.dataTransfer.files], e); });
  }

  // static markup: wire collapsible .lab-panel sections written by hand
  function enhance(root) {
    // hand-written rows: one label + one widget (or one checkbox) become instrument rows like the bound ones
    (root || doc).querySelectorAll('.lab-row').forEach((r) => {
      if (r._labInlined || r.classList.contains('lab-inline') || r.classList.contains('lab-full') || r.classList.contains('lab-keep-label')) return;
      const lab = r.querySelector(':scope > label:not(.lab-check)');
      if (!lab) return;
      const kids = [...r.children].filter((k) => k !== lab);
      if (kids.length !== 1) return;
      const k = kids[0];
      if (k.classList.contains('lab-widget') && !k.querySelector('.lab-in')) { k.prepend(el('span', 'lab-in', lab.textContent)); r.classList.add('lab-inline'); r._labInlined = true; }
      else if (k.classList.contains('lab-check') && !k.querySelector('.lab-in') && !k.textContent.trim()) { k.appendChild(el('span', 'lab-in', lab.textContent)); r.classList.add('lab-inline'); r._labInlined = true; }
    });
    (root || doc).querySelectorAll('.lab-panel-head').forEach((h) => {
      if (h._labWired) return; h._labWired = true;
      if (!h.querySelector('.lab-chev')) h.insertBefore(el('span', 'lab-chev'), h.firstChild);
      h.addEventListener('click', (e) => { if (e.target.closest('.lab-head-right')) return; h.parentElement.classList.toggle('collapsed'); });
    });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => enhance()); else enhance();

  // change a tool/button label without losing its icon
  function setLabel(target, text) {
    const b = typeof target === 'string' ? doc.querySelector(target) : target;
    if (!b) return;
    const t = b.querySelector('.lab-tool-text');
    if (t) t.textContent = text; else if (b.querySelector('svg')) { let span = b.querySelector('span'); if (!span) { span = el('span', 'lab-tool-text'); b.appendChild(span); } span.textContent = text; } else b.textContent = text;
  }

  // ================================================================ state layer
  // Pane.track(name, obj) declares a state root; every Binding / Pad / Curve on a tracked object
  // gets a path ("root.key"), a default, and reports its commits to the pane's History.
  // Pane.getState() / setState() move whole states; Project persists them; keys binds chords.
  const isPrim = (v) => v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean';
  const cloneV = (v) => (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
  const nest = (flat) => { const out = {}; Object.keys(flat).forEach((p) => { const i = p.indexOf('.'); const r = p.slice(0, i), k = p.slice(i + 1); (out[r] = out[r] || {})[k] = flat[p]; }); return out; };
  const fmtAny = (v) => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : (+v).toFixed(Math.abs(v) < 1 ? 3 : 2)) : String(v);

  // ---------------------------------------------------------------- keys: one document listener, chords by e.code
  const keys = {
    _b: [],
    // bind('KeyZ', 'mod+shift', fn, {label}) ; mods: mod (ctrl or meta), shift, alt, ctrl, meta, none
    bind(code, mods, fn, o) { const b = { code, mods: (mods || '').split('+').filter(Boolean), fn, label: (o && o.label) || '' }; this._b.push(b); return () => { this._b = this._b.filter((x) => x !== b); }; },
    list() { return this._b.map((b) => ({ code: b.code, mods: b.mods.join('+'), label: b.label })); },
    _match(b, e) {
      if (b.code !== e.code) return false;
      const want = (m) => b.mods.includes(m);
      const mod = e.ctrlKey || e.metaKey;
      if (want('mod') !== mod && !(want('ctrl') || want('meta'))) return false;
      if (want('ctrl') && !e.ctrlKey) return false;
      if (want('meta') && !e.metaKey) return false;
      if (want('shift') !== e.shiftKey) return false;
      if (want('alt') !== e.altKey) return false;
      return true;
    },
  };
  const inText = (t) => !!t && (t.tagName === 'INPUT' && !/^(checkbox|radio|range|color|file|button)$/i.test(t.type || '') || t.tagName === 'TEXTAREA' || t.isContentEditable);
  doc.addEventListener('keydown', (e) => {
    if (inText(e.target)) return;
    for (const b of keys._b) { if (keys._match(b, e)) { e.preventDefault(); b.fn(e); return; } }
  });

  // ---------------------------------------------------------------- flash: a short message in the status strip
  let lastShell = null, flashTimer = null;
  function flash(text, ms) {
    if (!lastShell) return;
    let f = lastShell.status.querySelector('.lab-flash');
    if (!f) { f = el('span', 'lab-flash'); lastShell.status.prepend(f); }
    f.textContent = text; f.hidden = false;
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { f.hidden = true; }, ms || 1800);
  }

  // ---------------------------------------------------------------- history
  class History extends Emitter {
    constructor(pane, o) {
      super(); o = o || {};
      this.pane = pane; this.cap = o.cap || 200; this.mergeMs = o.mergeMs != null ? o.mergeMs : 600;
      this.entries = []; this.index = -1; this.snapshots = []; this._open = null; this._tx = null; this._seq = 0;
    }
    get length() { return this.entries.length; }
    get canUndo() { return this.index >= 0; }
    get canRedo() { return this.index < this.entries.length - 1; }
    _id() { return 'h' + (++this._seq) + '_' + Date.now().toString(36); }
    _label(paths, before, after) {
      const lab = this.pane.pathLabel(paths[0]) || paths[0];
      if (paths.length === 1) return lab + ' ' + fmtAny(before[paths[0]]) + ' → ' + fmtAny(after[paths[0]]);
      return lab + ' +' + (paths.length - 1);
    }
    // from controls: a drag reports last=false until the pointer lifts; single commits merge inside mergeMs
    record(paths, befores, afters, last, label) {
      const now = Date.now();
      const b = {}, a = {}; paths.forEach((p, i) => { b[p] = cloneV(befores[i]); a[p] = cloneV(afters[i]); });
      if (last && !this._open && !this._tx && paths.every((p) => b[p] === a[p])) return;   // nothing changed, nothing open
      if (this._tx) { Object.keys(a).forEach((p) => { if (!(p in this._tx.before)) this._tx.before[p] = b[p]; this._tx.after[p] = a[p]; }); return; }
      if (!last) {
        if (!this._open) this._open = { id: this._id(), t: now, kind: 'param', label: label || '', before: b, after: a, paths };
        else Object.assign(this._open.after, a);
        return;
      }
      if (this._open) { Object.assign(this._open.after, a); const e = this._open; this._open = null; e.label = this._label(e.paths, e.before, e.after); this.push(e); return; }
      const prev = this.entries[this.index];
      if (prev && prev.kind === 'param' && this.index === this.entries.length - 1 && now - prev.t < this.mergeMs && prev.paths.length === paths.length && prev.paths.every((p) => paths.includes(p))) {
        Object.assign(prev.after, a); prev.t = now; prev.label = this._label(prev.paths, prev.before, prev.after); this.emit('change', { entry: prev, merged: true }); return;
      }
      this.push({ id: this._id(), t: now, kind: 'param', label: this._label(paths, b, a), before: b, after: a, paths });
    }
    push(e) {
      if (!e.id) e.id = this._id(); if (!e.t) e.t = Date.now(); if (!e.paths) e.paths = Object.keys(e.after || {});
      this.entries.splice(this.index + 1); this.entries.push(e);
      while (this.entries.length > this.cap) this.entries.shift();
      this.index = this.entries.length - 1;
      this.emit('change', { entry: e });
    }
    // explicit transaction: everything the function changes (through setState or controls) is one entry
    transaction(label, fn, o) {
      if (this._tx) { return fn(); }
      this._tx = { label, before: {}, after: {}, kind: (o && o.kind) || 'state' };
      const s0 = this.pane.getState();
      let out; try { out = fn(); } finally {
        const tx = this._tx; this._tx = null;
        const s1 = this.pane.getState();
        const b = {}, a = {}; let n = 0;
        Object.keys(s1).forEach((r) => Object.keys(s1[r]).forEach((k) => { if (s0[r] && s0[r][k] !== s1[r][k]) { b[r + '.' + k] = cloneV(s0[r][k]); a[r + '.' + k] = cloneV(s1[r][k]); n++; } }));
        Object.keys(tx.after).forEach((p) => { if (!(p in a)) { a[p] = tx.after[p]; b[p] = tx.before[p]; n++; } });
        const last = this.entries[this.index];
        if (n && o && o.amend && last && this.index === this.entries.length - 1) {
          Object.keys(a).forEach((p) => { if (!(p in last.before)) last.before[p] = b[p]; last.after[p] = a[p]; });
          last.paths = Object.keys(last.after); if (label) last.label = label; last.kind = tx.kind; last.t = Date.now(); this.emit('change', { entry: last, merged: true });
        } else if (n) this.push({ kind: tx.kind, label: label || (n + ' changes'), before: b, after: a, paths: Object.keys(a) });
      }
      return out;
    }
    beginTx(label) { if (this._tx) return; this._tx = { label, before: {}, after: {}, kind: 'state' }; this._txState = this.pane.getState(); }
    commitTx() {
      if (!this._tx) return; const tx = this._tx, s0 = this._txState; this._tx = null; this._txState = null;
      const s1 = this.pane.getState(); const b = {}, a = {}; let n = 0;
      Object.keys(s1).forEach((r) => Object.keys(s1[r]).forEach((k) => { if (s0[r] && s0[r][k] !== s1[r][k]) { b[r + '.' + k] = cloneV(s0[r][k]); a[r + '.' + k] = cloneV(s1[r][k]); n++; } }));
      if (n) this.push({ kind: tx.kind, label: tx.label, before: b, after: a, paths: Object.keys(a) });
    }
    cancelTx() { this._tx = null; this._txState = null; }
    undo() {
      const e = this.entries[this.index]; if (!e) return false;
      this.pane.setState(nest(e.before), { noHistory: true, source: 'undo' }); this.index--;
      flash('Undo: ' + e.label); this.emit('change', { entry: e, undo: true }); return true;
    }
    redo() {
      const e = this.entries[this.index + 1]; if (!e) return false;
      this.pane.setState(nest(e.after), { noHistory: true, source: 'redo' }); this.index++;
      flash('Redo: ' + e.label); this.emit('change', { entry: e, redo: true }); return true;
    }
    jump(id) {
      const j = id == null ? -1 : this.entries.findIndex((e) => e.id === id); if (id != null && j < 0) return;
      while (this.index > j) this.undo();
      while (this.index < j) this.redo();
    }
    snapshot(name) { const s = { id: this._id(), t: Date.now(), name: name || ('Snapshot ' + (this.snapshots.length + 1)), state: this.pane.getState() }; this.snapshots.push(s); this.emit('change', { snapshot: s }); return s; }
    restoreSnapshot(id) { const s = this.snapshots.find((x) => x.id === id); if (!s) return; this.pane.setState(s.state, { label: 'Snapshot ' + s.name, kind: 'snapshot', source: 'snapshot' }); }
    removeSnapshot(id) { this.snapshots = this.snapshots.filter((x) => x.id !== id); this.emit('change', {}); }
    serialise(n) { const e = this.entries.slice(-(n || 100)); return { entries: e, index: Math.min(this.index, e.length - 1) - Math.max(0, this.index - (e.length - 1)), snapshots: this.snapshots }; }
    load(h) { if (!h) return; this.entries = Array.isArray(h.entries) ? h.entries : []; this.index = typeof h.index === 'number' ? Math.min(h.index, this.entries.length - 1) : this.entries.length - 1; this.snapshots = Array.isArray(h.snapshots) ? h.snapshots : []; this.emit('change', { loaded: true }); }
    clear() { this.entries = []; this.index = -1; this._open = null; this.emit('change', {}); }
  }

  // ---------------------------------------------------------------- history folder (list of steps + snapshots)
  function historyFolder(pane, o) {
    o = o || {};
    const f = pane.addFolder({ title: o.title || 'History', expanded: o.expanded === true });
    const h = pane.history;
    f.addButtons([{ title: 'undo', onClick: () => h.undo() }, { title: 'redo', onClick: () => h.redo() }, { title: 'snapshot', onClick: () => h.snapshot() }], { cols: 3 });
    const list = el('div', 'lab-hist'); f.addElement(list);
    f.addSubhead('snapshots');
    const snaps = el('div', 'lab-hist lab-hist-snaps'); f.addElement(snaps);
    const rel = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? Math.round(s) + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };
    const paint = () => {
      if (!f.expanded && !o.always) return;
      list.textContent = '';
      const start = el('button', 'lab-hist-row' + (h.index < 0 ? ' on' : ''), ''); start.type = 'button';
      start.append(el('span', 'lab-hist-lab', 'start'), el('span', 'lab-hist-t', ''));
      start.addEventListener('click', () => h.jump(null)); list.appendChild(start);
      const from = Math.max(0, h.entries.length - (o.rows || 60));
      h.entries.slice(from).forEach((e, i) => {
        const idx = from + i;
        const r = el('button', 'lab-hist-row' + (idx === h.index ? ' on' : '') + (idx > h.index ? ' lab-hist-future' : '')); r.type = 'button';
        r.append(el('span', 'lab-hist-lab', e.label || e.kind), el('span', 'lab-hist-t', rel(e.t)));
        r.addEventListener('click', () => h.jump(e.id));
        list.appendChild(r);
      });
      list.scrollTop = list.scrollHeight;
      snaps.textContent = '';
      h.snapshots.forEach((s) => {
        const r = el('button', 'lab-hist-row'); r.type = 'button';
        r.append(el('span', 'lab-hist-lab', s.name), el('span', 'lab-hist-t', rel(s.t)));
        r.addEventListener('click', () => h.restoreSnapshot(s.id));
        r.addEventListener('contextmenu', (e) => { e.preventDefault(); h.removeSnapshot(s.id); });
        snaps.appendChild(r);
      });
      snaps.hidden = !h.snapshots.length;
    };
    h.on('change', paint); f.on('fold', paint); paint();
    f.paint = paint;
    return f;
  }

  // ---------------------------------------------------------------- LabStore: IndexedDB + OPFS, no deps
  const LabStore = {
    STORES: ['projects', 'handles', 'presets', 'thumbs', 'bakes'],
    _p: null,
    open() {
      if (this._p) return this._p;
      this._p = new Promise((res) => {
        try {
          const rq = indexedDB.open('lab-ui', 1);
          rq.onupgradeneeded = () => { const db = rq.result; this.STORES.forEach((s) => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); }); };
          rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); rq.onblocked = () => res(null);
        } catch (_) { res(null); }
      });
      return this._p;
    },
    async _tx(store, mode, fn) {
      const db = await this.open(); if (!db) return null;
      return new Promise((res) => { try { const t = db.transaction(store, mode); const rq = fn(t.objectStore(store)); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); } catch (_) { res(null); } });
    },
    get(store, key) { return this._tx(store, 'readonly', (s) => s.get(key)); },
    put(store, key, val) { return this._tx(store, 'readwrite', (s) => s.put(val, key)); },
    del(store, key) { return this._tx(store, 'readwrite', (s) => s.delete(key)); },
    keys(store) { return this._tx(store, 'readonly', (s) => s.getAllKeys()); },
    async persist() { try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch (_) { return false; } },
    async estimate() { try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (_) { return null; } },
    opfs: {
      async _dir(path, create) {
        if (!navigator.storage || !navigator.storage.getDirectory) return null;
        let d = await navigator.storage.getDirectory();
        const parts = path.split('/').filter(Boolean); const name = parts.pop();
        for (const p of parts) { try { d = await d.getDirectoryHandle(p, { create: !!create }); } catch (_) { return null; } }
        return { dir: d, name };
      },
      async put(path, blob) {
        try { const h = await this._dir(path, true); if (!h) return false; const fh = await h.dir.getFileHandle(h.name, { create: true }); const w = await fh.createWritable(); await w.write(blob); await w.close(); return true; } catch (_) { return false; }
      },
      async get(path, name, opts) {
        try { const h = await this._dir(path, false); if (!h) return null; const fh = await h.dir.getFileHandle(h.name); const f = await fh.getFile(); return name ? new File([f], name, Object.assign({ type: f.type, lastModified: f.lastModified }, opts || {})) : f; } catch (_) { return null; }
      },
      async del(path) { try { const h = await this._dir(path, false); if (!h) return false; await h.dir.removeEntry(h.name); return true; } catch (_) { return false; } },
      async has(path) { try { const h = await this._dir(path, false); if (!h) return false; await h.dir.getFileHandle(h.name); return true; } catch (_) { return false; } },
    },
  };

  // ---------------------------------------------------------------- Project: serialise, autosave, restore, re-link, save/open
  // new Project(pane, { tool, app, shell, source:{ restore(desc, file), label(desc) }, extra:{ get(), set(obj) }, autosaveMs })
  class Project extends Emitter {
    constructor(pane, o) {
      super(); o = o || {};
      this.pane = pane; this.o = o; this.tool = o.tool || 'lab'; this.app = o.app || this.tool;
      this.shell = o.shell || lastShell; this.name = ''; this.created = Date.now(); this.modified = this.created;
      this.sourceDesc = null; this._dirty = false; this._handle = null; this._saveTimer = null; this.autosaveMs = o.autosaveMs != null ? o.autosaveMs : 1000;
      this.key = this.tool + ':current'; this.sourceCap = o.sourceCap || 1e9; this._ready = false; this._files = new Map();
      pane.project = this;
      pane.on('change', (ev) => { if (ev && ev.last === false) return; this.touch(); });
      pane.history.on('change', () => this.touch());
      pane.on('fold', () => this.touch());
      pane.on('locks', () => this.touch());
      if (this.shell && this.shell.viewer) this.shell.viewer.on('view', () => this.touch());
      global.addEventListener('pagehide', () => this.flush());
      doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') this.flush(); });
      keys.bind('KeyS', 'mod', () => this.save(), { label: 'Save project' });
      keys.bind('KeyO', 'mod', () => this.open(), { label: 'Open project' });
      keys.bind('KeyC', 'mod+shift', () => this.copyLook(), { label: 'Copy look link' });
      this._mark();
    }
    get dirty() { return this._dirty; }
    set dirty(v) { this._dirty = !!v; this._mark(); }
    _mark() {
      const s = this.shell; if (!s) return;
      let d = s.brand.querySelector('.lab-dirty'); if (!d) { d = el('span', 'lab-dirty', '•'); d.title = 'unsaved changes'; s.brand.appendChild(d); }
      d.hidden = !this._dirty;
      if (s.docRef && s.docRef.setTitle && this._titleBase) s.docRef.setTitle(this._titleBase + (this._dirty ? ' •' : ''));
    }
    setTitle(t) { this._titleBase = t; this._mark(); }
    touch() { if (!this._ready || this._loading) return; this.modified = Date.now(); if (!this._dirty && !this._restoring) { this._dirty = true; this._mark(); } this.emit('dirty', { dirty: true }); clearTimeout(this._saveTimer); this._saveTimer = setTimeout(() => this.autosave(), this.autosaveMs); }
    serialise(o) {
      o = o || {};
      const out = { schema: 'lab-project@1', tool: this.tool, app: this.app, name: this.name, created: this.created, modified: this.modified,
        source: this.sourceDesc ? cloneV(this.sourceDesc) : null, params: this.pane.getState(), folds: this.pane.getFolds() };
      if (this.o.extra && this.o.extra.get) out.extra = cloneV(this.o.extra.get());
      if (this.shell && this.shell.viewer && this.shell.viewer.canvas) out.view = this.shell.viewer.getState();
      out.locks = [...this.pane.locks]; out.random = { seed: this.pane.seed | 0, rolls: this.pane.rolls | 0, deviation: this.pane.deviation != null ? this.pane.deviation : 0.25 };
      if (!o.noHistory) out.history = this.pane.history.serialise(o.historyN || 100);
      return out;
    }
    load(obj, o) {
      o = o || {};
      if (!obj || obj.schema !== 'lab-project@1') throw new Error('not a lab project');
      if (obj.tool && obj.tool !== this.tool) throw new Error('project is for ' + obj.tool);
      this.name = obj.name || ''; this.created = obj.created || Date.now(); this.modified = obj.modified || Date.now();
      this._loading = true;
      try {
        if (obj.params) this.pane.setState(obj.params, { noHistory: true, source: o.source || 'project' });
        if (obj.folds) this.pane.setFolds(obj.folds);
        if (obj.extra && this.o.extra && this.o.extra.set) this.o.extra.set(obj.extra);
        if (obj.view && this.shell && this.shell.viewer && this.shell.viewer.canvas) this.shell.viewer.setState(obj.view);
        if (Array.isArray(obj.locks)) this.pane.setLocks(obj.locks);
        if (obj.random) { this.pane.seed = obj.random.seed | 0; this.pane.rolls = obj.random.rolls | 0; if (obj.random.deviation != null) { this.pane.deviation = obj.random.deviation; if (this.pane._rand) { this.pane._rand.deviation = obj.random.deviation; this.pane.refresh(); } } }
        if (obj.history && !o.noHistory) this.pane.history.load(obj.history); else if (!o.keepHistory) this.pane.history.clear();
        this.sourceDesc = obj.source || null;
      } finally { this._loading = false; }
      this.emit('load', { project: obj });
    }
    async autosave() { if (!this._ready) return false; clearTimeout(this._saveTimer); const ok = await LabStore.put('projects', this.key, this.serialise()); this.emit('autosave', { ok: ok !== null }); return ok !== null; }
    flush() { if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; this.autosave(); } }
    // restore the autosaved project, then the source; resolves true when a project was found
    async restore(o) {
      o = o || {};
      let obj = await LabStore.get('projects', this.key);
      if (!obj && o.migrate) { try { obj = await o.migrate(); } catch (_) { obj = null; } }
      this._ready = true;
      if (!obj) { this.emit('ready', { restored: false }); await this.applyHash(); return false; }
      try { this.load(obj, { source: 'restore' }); } catch (e) { console.warn('project restore:', e); this.emit('ready', { restored: false }); return false; }
      this._restoring = true;
      try { await this.restoreSource(); } finally { this._restoring = false; }
      this._dirty = false; this._mark();
      this.emit('ready', { restored: true });
      await this.applyHash();
      return true;
    }
    async restoreSource() {
      const d = this.sourceDesc; if (!d || !this.o.source || !this.o.source.restore) return false;
      if (d.kind === 'file') {
        let f = this._files.get(d.fp) || null;
        if (!f && d.opfs) f = await LabStore.opfs.get(d.opfs, d.name, { type: d.type, lastModified: d.lastModified });
        if (f) { this._files.set(d.fp, f); await this.o.source.restore(d, f); this.hideRelink(); return true; }
        this.showRelink(d); return false;
      }
      await this.o.source.restore(d, null); this.hideRelink(); return true;
    }
    // tools call this when a source is loaded; file sources are copied into OPFS in the background
    setSource(desc, file) {
      if (this._restoring) return this.sourceDesc;
      desc = Object.assign({}, desc || {});
      if (file) {
        desc.kind = 'file'; desc.name = file.name; desc.size = file.size; desc.lastModified = file.lastModified; desc.type = file.type;
        desc.fp = Project.fingerprint(file); this._files.set(desc.fp, file);
        const path = 'sources/' + desc.fp;
        if (file.size <= this.sourceCap) {
          LabStore.opfs.has(path).then(async (has) => {
            if (!has) { const est = await LabStore.estimate(); if (est && est.quota && est.usage + file.size > est.quota * 0.9) return; if (!(await LabStore.opfs.put(path, file))) return; LabStore.persist(); }
            if (this.sourceDesc && this.sourceDesc.fp === desc.fp) { this.sourceDesc.opfs = path; this.touch(); }
          });
        }
      }
      this.sourceDesc = desc; this.hideRelink(); this.touch();
      return desc;
    }
    updateSource(patch) { if (this.sourceDesc) { Object.assign(this.sourceDesc, patch); this.touch(); } }
    static fingerprint(f) { return [f.name, f.size, f.lastModified].join('|').replace(/[^\w.|-]+/g, '_'); }
    showRelink(d) {
      const s = this.shell; if (!s) return;
      let r = s.view.querySelector('.lab-relink');
      if (!r) { r = el('div', 'lab-relink'); r.append(el('span', 'lab-relink-text'), el('button', 'lab-btn lab-accent', 'Re-link'), el('button', 'lab-btn', 'Dismiss')); s.view.appendChild(r);
        r.children[1].addEventListener('click', () => this.relink());
        r.children[2].addEventListener('click', () => this.hideRelink()); }
      const lab = this.o.source && this.o.source.label ? this.o.source.label(d) : (d.name || d.kind);
      r.firstChild.textContent = 'Re-link: ' + lab; r.hidden = false;
    }
    hideRelink() { const s = this.shell; if (!s) return; const r = s.view.querySelector('.lab-relink'); if (r) r.hidden = true; }
    async relink() {
      const d = this.sourceDesc; if (!d) return;
      let f = null;
      if (global.showOpenFilePicker) { try { const [h] = await global.showOpenFilePicker({ multiple: false }); f = await h.getFile(); } catch (_) { return; } }
      else { f = await new Promise((res) => { const i = el('input'); i.type = 'file'; i.onchange = () => res(i.files[0] || null); i.click(); }); }
      if (!f) return;
      if (Project.fingerprint(f) !== d.fp) flash('Re-linked a different file: ' + f.name, 2500);
      const desc = Object.assign({}, d); this.setSource(desc, f);
      await this.o.source.restore(this.sourceDesc, f);
    }
    fileName() { return (this.name || (this.sourceDesc && this.sourceDesc.name ? this.sourceDesc.name.replace(/\.[^.]+$/, '') : this.tool)) + '.' + this.tool + '.json'; }
    async save() {
      const json = JSON.stringify(this.serialise(), null, 1);
      if (global.showSaveFilePicker) {
        try {
          if (!this._handle) this._handle = await global.showSaveFilePicker({ suggestedName: this.fileName(), types: [{ description: 'Lab project', accept: { 'application/json': ['.json'] } }] });
          const w = await this._handle.createWritable(); await w.write(json); await w.close();
          this.name = this._handle.name.replace(/\.[^.]+\.json$|\.json$/, '');
        } catch (e) { if (e && e.name === 'AbortError') return false; this._handle = null; this._download(json); }
      } else this._download(json);
      this._dirty = false; this._mark(); flash('Saved ' + this.fileName()); this.emit('save', {}); this.autosave();
      return true;
    }
    _download(json) { const a = el('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = this.fileName(); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
    async open() {
      let f = null;
      if (global.showOpenFilePicker) { try { const [h] = await global.showOpenFilePicker({ types: [{ description: 'Lab project', accept: { 'application/json': ['.json'] } }] }); this._handle = h; f = await h.getFile(); } catch (_) { return false; } }
      else { f = await new Promise((res) => { const i = el('input'); i.type = 'file'; i.accept = '.json,application/json'; i.onchange = () => res(i.files[0] || null); i.click(); }); }
      if (!f) return false;
      return this.loadFile(f);
    }
    // returns false (quietly) when the file is not a project for this tool, so drop handlers can fall through to media
    async loadFile(f) {
      if (!/\.json$/i.test(f.name)) return false;
      let obj; try { obj = JSON.parse(await f.text()); } catch (_) { return false; }
      if (!obj || obj.schema !== 'lab-project@1' || (obj.tool && obj.tool !== this.tool)) return false;
      this.pane.history.transaction('Open ' + f.name, () => this.load(obj, { keepHistory: true, noHistory: true, source: 'open' }), { kind: 'project' });
      this.name = this.name || f.name.replace(/\.[^.]+\.json$|\.json$/, '');
      this._dirty = false; this._mark(); await this.restoreSource(); flash('Opened ' + f.name); this.autosave();
      return true;
    }
    async reset() { clearTimeout(this._saveTimer); await LabStore.del('projects', this.key); }
  }

  // ================================================================ preset grid: user layer and look URLs
  // grid.addUser({ pane, tool, canvas, exclude: [path or 'root.' prefix], resolve: (name) => state, apply?: (state, o) => void })
  // User tiles saved from the current state with a thumbnail; favourites; rename / duplicate / update / export / delete;
  // drag to reorder; drop .json to import; alt-hover preview; amount; folder scope (shift+click); modified marker.
  const lerpHex = (a, b, t) => { const pa = /^#[0-9a-f]{6}$/i.test(a) && /^#[0-9a-f]{6}$/i.test(b); if (!pa) return t < 0.5 ? a : b; const h = (s, i) => parseInt(s.slice(i, i + 2), 16); const c = (i) => Math.round(h(a, i) + (h(b, i) - h(a, i)) * t); return '#' + [1, 3, 5].map((i) => c(i).toString(16).padStart(2, '0')).join(''); };
  // interpolate between two (partial) states: numbers and hex colours blend, everything else switches at 50 %
  function lerpState(base, target, t) {
    t = clamp(+t || 0, 0, 1); const out = {};
    Object.keys(target || {}).forEach((r) => { out[r] = {}; Object.keys(target[r]).forEach((k) => {
      const a = base && base[r] ? base[r][k] : undefined, b = target[r][k];
      if (a === undefined || t >= 1) out[r][k] = b;
      else if (typeof a === 'number' && typeof b === 'number') out[r][k] = a + (b - a) * t;
      else if (typeof a === 'string' && typeof b === 'string' && a[0] === '#') out[r][k] = lerpHex(a, b, t);
      else out[r][k] = t < 0.5 ? a : b;
    }); });
    return out;
  }
  const excluded = (path, ex) => (ex || []).some((e) => e.endsWith('.') ? path.startsWith(e) : path === e);
  function filterState(state, ex, keep) {
    const out = {}; Object.keys(state || {}).forEach((r) => { Object.keys(state[r]).forEach((k) => { const p = r + '.' + k; if (excluded(p, ex)) return; if (keep && !keep.has(p)) return; (out[r] = out[r] || {})[k] = cloneV(state[r][k]); }); });
    return out;
  }
  function contextMenu(x, y, items) {
    const old = doc.querySelector('.lab-ctx'); if (old) old.remove();
    const dd = el('div', 'lab-dropdown lab-ctx');
    items.forEach((it) => { if (it.sep) { dd.appendChild(el('hr')); return; } const b = el('button'); b.type = 'button'; b.appendChild(el('span', null, it.title)); if (it.danger) b.classList.add('lab-danger'); b.addEventListener('click', () => { close(); it.onClick(); }); dd.appendChild(b); });
    doc.body.appendChild(dd);
    dd.style.left = Math.min(x, global.innerWidth - 230) + 'px'; dd.style.top = Math.min(y, global.innerHeight - dd.offsetHeight - 8) + 'px';
    const close = () => { dd.remove(); doc.removeEventListener('pointerdown', onDown, true); doc.removeEventListener('keydown', onKey, true); };
    const onDown = (e) => { if (!dd.contains(e.target)) close(); }, onKey = (e) => { if (e.key === 'Escape') close(); };
    setTimeout(() => { doc.addEventListener('pointerdown', onDown, true); doc.addEventListener('keydown', onKey, true); }, 0);
    return dd;
  }
  const presetUser = {
    addUser(o) {
      o = o || {}; const g = this; const pane = o.pane; if (!pane) throw new Error('addUser needs a pane');
      g.userOpts = o; g.tool = o.tool || (pane.project && pane.project.tool) || 'lab'; g.user = []; g.userThumbs = {}; g.modified = false; g.filter = 'all'; g._amt = { amount: 100 };
      g.grid.classList.add('lab-has-user');
      // filter row above the grid
      const fr = el('div', 'lab-btns lab-grid-3 lab-presets-filter');
      ['all', 'mine', '★'].forEach((f) => { const b = el('button', 'lab-btn' + (f === 'all' ? ' on' : ''), f); b.type = 'button'; b.addEventListener('click', () => g.setFilter(f === '★' ? 'fav' : f)); fr.appendChild(b); });
      g.element.insertBefore(fr, g.grid); g.filterRow = fr;
      // the "+" tile
      const add = el('button', 'lab-btn lab-thumb lab-add'); add.type = 'button'; add.title = 'save the current look';
      add.append(el('span', 'lab-add-plus', '+'), el('span', 'lab-thumb-cap', 'save look'));
      add.addEventListener('click', () => g.saveUser());
      add.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, [{ title: 'Import preset…', onClick: () => g.importPicker() }]); });
      g.grid.appendChild(add); g.addTile = add;
      // amount row under the grid
      if (g.parent && g.parent.addBinding) { g.amountCtl = g.parent.addBinding(g._amt, 'amount', { label: 'amount', min: 0, max: 100, step: 1, unit: '%' }); }
      // built-in tiles: context menu, alt-hover preview, shift-scope; clicks route through pick()
      Object.keys(g.buttons).forEach((name) => g._wireTile(g.buttons[name], name, false));
      // modified marker: any edit after a pick
      pane.on('change', (ev) => { if (ev && !ev.programmatic && ev.last !== false) g.markModified(); });
      pane.on('state', (ev) => { if (ev.source !== 'preset' && ev.source !== 'preview' && ev.source !== 'control') g.markModified(); });
      doc.addEventListener('keyup', (e) => { if (e.key === 'Alt') g.endPreview(); });
      // drop a .json preset on the grid
      g.grid.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.stopPropagation(); } });
      g.grid.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f && /\.json$/i.test(f.name)) { e.preventDefault(); e.stopPropagation(); g.importFile(f); } });
      g.loadUser();
      return g;
    },
    _key(id) { return this.tool + ':' + id; },
    _wireTile(b, id, isUser) {
      const g = this;
      b.onclick = null; const clone = b.cloneNode(true); b.replaceWith(clone); b = clone; g.buttons[id] = b;
      if (isUser) { g.userThumbs[id] = b.querySelector('.lab-thumb-img'); } else if (b.querySelector('.lab-thumb-img')) g.thumbs[id] = b.querySelector('.lab-thumb-img');
      b.addEventListener('click', (e) => g.pick(id, { scope: e.shiftKey }));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); g.menu(id, isUser, e.clientX, e.clientY); });
      b.addEventListener('pointerenter', (e) => { if (e.altKey) g.preview(id); });
      b.addEventListener('pointerleave', () => g.endPreview());
      if (isUser) {
        b.draggable = true;
        b.addEventListener('dragstart', (e) => { g._drag = id; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', id); } catch (_) {} });
        b.addEventListener('dragover', (e) => { if (g._drag && g._drag !== id) { e.preventDefault(); b.classList.add('lab-dragover'); } });
        b.addEventListener('dragleave', () => b.classList.remove('lab-dragover'));
        b.addEventListener('drop', (e) => { b.classList.remove('lab-dragover'); if (g._drag && g._drag !== id) { e.preventDefault(); e.stopPropagation(); g.reorder(g._drag, id); } g._drag = null; });
        b.addEventListener('dragend', () => { g._drag = null; });
      }
      return b;
    },
    // state of a tile: a user record's params or the tool's resolve(name) for a built-in, minus the excluded paths
    stateOf(id) {
      const u = this.user.find((x) => x.id === id);
      if (u) return filterState(u.params, this.userOpts.exclude);
      const s = this.userOpts.resolve ? this.userOpts.resolve(id) : null;
      return s ? filterState(s, this.userOpts.exclude) : null;
    },
    labelOf(id) { const u = this.user.find((x) => x.id === id); return u ? u.name : id; },
    pick(id, o) {
      o = o || {}; const g = this, pane = g.userOpts.pane; const target = g.stateOf(id); if (!target) { if (g.userOpts.onSelect) g.userOpts.onSelect(id); return; }
      let keep = null;
      if (o.scope) { const f = (pane.focusedFolder && pane.focusedFolder()) || null; if (f) { keep = new Set(f.bindings().map((b) => b.path).filter(Boolean)); } }
      const part = keep ? filterState(target, null, keep) : target;
      const amount = (g._amt ? g._amt.amount : 100) / 100;
      const next = lerpState(pane.getState(), part, amount);
      const label = 'Preset ' + g.labelOf(id) + (amount < 1 ? ' ' + Math.round(amount * 100) + '%' : '') + (keep ? ' (folder)' : '');
      if (g.userOpts.apply) g.userOpts.apply(next, { label, id, amount, scope: !!keep }); else pane.setState(next, { label, source: 'preset' });
      g.select(id); g.modified = false; g._paintCaps();
      g.emit('apply', { id, amount, scope: !!keep, target: g });
      if (g.userOpts.onSelect) g.userOpts.onSelect(id);
    },
    markModified() { if (!this.current || this.modified) return; this.modified = true; this._paintCaps(); },
    _paintCaps() {
      const g = this; Object.keys(g.buttons).forEach((id) => { const cap = g.buttons[id].querySelector('.lab-thumb-cap'); if (!cap) return; const u = g.user.find((x) => x.id === id); const base = u ? u.name : (g.userOpts && g.userOpts.format ? g.userOpts.format(id) : id); cap.textContent = base + (g.modified && g.current === id ? ' *' : ''); });
    },
    preview(id) {
      const g = this, pane = g.userOpts.pane; if (g._previewSaved) return; const target = g.stateOf(id); if (!target) return;
      g._previewSaved = pane.getState(); pane.setState(target, { noHistory: true, source: 'preview' });
    },
    endPreview() { const g = this, pane = g.userOpts.pane; if (!g._previewSaved) return; const s = g._previewSaved; g._previewSaved = null; pane.setState(s, { noHistory: true, source: 'preview' }); },
    setFilter(f) {
      this.filter = f; [...this.filterRow.children].forEach((b, i) => b.classList.toggle('on', ['all', 'mine', 'fav'][i] === f));
      Object.keys(this.buttons).forEach((id) => { const u = this.user.find((x) => x.id === id); const show = f === 'all' || (f === 'mine' && !!u) || (f === 'fav' && !!(u && u.fav)); this.buttons[id].hidden = !show; });
    },
    async captureThumb() {
      const c = this.userOpts.canvas; if (!c) return null;
      try {
        const w = 192, h = 108; const t = doc.createElement('canvas'); t.width = w; t.height = h; const x = t.getContext('2d');
        const sw = c.width || c.videoWidth || 1, sh = c.height || c.videoHeight || 1, sa = sw / sh, ta = w / h; let cw = sw, ch = sh; if (sa > ta) cw = sh * ta; else ch = sw / ta;
        x.fillStyle = '#000'; x.fillRect(0, 0, w, h); x.drawImage(c, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, w, h);
        return await new Promise((res) => t.toBlob(res, 'image/png'));
      } catch (_) { return null; }
    },
    _tile(rec) {
      const b = el('button', 'lab-btn lab-thumb lab-user' + (rec.fav ? ' lab-fav' : '')); b.type = 'button'; b.title = rec.name;
      const img = el('canvas', 'lab-thumb-img'); img.width = 192; img.height = 108;
      b.append(img, el('span', 'lab-thumb-cap', rec.name));
      return b;
    },
    _paintThumb(id, blob) { const cv = this.userThumbs[id]; if (!cv || !blob) return; const i = new Image(); i.onload = () => { cv.getContext('2d').drawImage(i, 0, 0, cv.width, cv.height); URL.revokeObjectURL(i.src); }; i.src = URL.createObjectURL(blob); },
    async loadUser() {
      const g = this; const keys_ = (await LabStore.keys('presets')) || []; const mine = keys_.filter((k) => String(k).startsWith(g.tool + ':'));
      const recs = []; for (const k of mine) { const r = await LabStore.get('presets', k); if (r && r.id) recs.push(r); }
      recs.sort((a, b) => (a.order || 0) - (b.order || 0));
      g.user = recs; g._mountUser();
      for (const r of recs) { const t = await LabStore.get('thumbs', g._key(r.id)); if (t) g._paintThumb(r.id, t); }
      g.setFilter(g.filter); g.emit('userload', { count: recs.length });
    },
    _mountUser() {
      const g = this; g.grid.querySelectorAll('.lab-user').forEach((n) => n.remove()); g.userThumbs = {};
      g.user.forEach((r) => { let b = g._tile(r); g.grid.insertBefore(b, g.addTile); b = g._wireTile(b, r.id, true); if (g.current === r.id) b.classList.add('on'); });
      g._paintCaps();
    },
    async saveUser(name, state) {
      const g = this, pane = g.userOpts.pane;
      const base = g.current ? g.labelOf(g.current).replace(/\s*\*$/, '') : 'Look';
      const n = g.user.filter((u) => u.name.startsWith(base)).length + 1;
      const rec = { id: 'u' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), tool: g.tool, name: name || (base + ' ' + n), params: filterState(state || pane.getState(), g.userOpts.exclude), created: Date.now(), modified: Date.now(), fav: false, order: (g.user.length ? Math.max(...g.user.map((u) => u.order || 0)) : 0) + 1, derived: g.current || null };
      await LabStore.put('presets', g._key(rec.id), rec);
      const blob = await g.captureThumb(); if (blob) await LabStore.put('thumbs', g._key(rec.id), blob);
      g.user.push(rec); g._mountUser(); if (blob) g._paintThumb(rec.id, blob); g.setFilter(g.filter);
      g.select(rec.id); g.modified = false; g._paintCaps(); flash('Saved look ' + rec.name);
      g.emit('usersave', { rec }); return rec;
    },
    async updateUser(id) { const g = this, r = g.user.find((x) => x.id === id); if (!r) return; r.params = filterState(g.userOpts.pane.getState(), g.userOpts.exclude); r.modified = Date.now(); await LabStore.put('presets', g._key(id), r); const blob = await g.captureThumb(); if (blob) { await LabStore.put('thumbs', g._key(id), blob); g._paintThumb(id, blob); } g.modified = false; g._paintCaps(); flash('Updated ' + r.name); },
    async renameUser(id, name) { const r = this.user.find((x) => x.id === id); if (!r || !name) return; r.name = name; r.modified = Date.now(); await LabStore.put('presets', this._key(id), r); this.buttons[id].title = name; this._paintCaps(); },
    async removeUser(id) { const g = this; g.user = g.user.filter((x) => x.id !== id); await LabStore.del('presets', g._key(id)); await LabStore.del('thumbs', g._key(id)); const b = g.buttons[id]; if (b) b.remove(); delete g.buttons[id]; delete g.userThumbs[id]; if (g.current === id) { g.current = null; } },
    async favourite(id, on) { const r = this.user.find((x) => x.id === id); if (!r) return; r.fav = on == null ? !r.fav : !!on; await LabStore.put('presets', this._key(id), r); this.buttons[id].classList.toggle('lab-fav', r.fav); this.setFilter(this.filter); },
    async duplicate(id) { const g = this; const u = g.user.find((x) => x.id === id); const st = u ? u.params : g.stateOf(id); if (!st) return; const rec = await g.saveUser((u ? u.name : id) + ' copy', st); if (!u) { const src = g.thumbs[id]; if (src && src.tagName === 'CANVAS') { const cv = g.userThumbs[rec.id]; cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height); cv.toBlob((b) => b && LabStore.put('thumbs', g._key(rec.id), b), 'image/png'); } } },
    async reorder(fromId, toId) { const g = this; const ids = g.user.map((u) => u.id); const i = ids.indexOf(fromId), j = ids.indexOf(toId); if (i < 0 || j < 0) return; const [m] = g.user.splice(i, 1); g.user.splice(j, 0, m); g.user.forEach((u, k) => { u.order = k + 1; }); await Promise.all(g.user.map((u) => LabStore.put('presets', g._key(u.id), u))); g._mountUser(); for (const u of g.user) { const t = await LabStore.get('thumbs', g._key(u.id)); if (t) g._paintThumb(u.id, t); } g.setFilter(g.filter); },
    rename(id) {
      const g = this, b = g.buttons[id], r = g.user.find((x) => x.id === id); if (!b || !r) return;
      const cap = b.querySelector('.lab-thumb-cap'); const i = el('input', 'lab-thumb-rename'); i.value = r.name; cap.replaceWith(i); i.focus(); i.select();
      const done = (ok) => { const v = i.value.trim(); i.replaceWith(cap); if (ok && v) g.renameUser(id, v); else g._paintCaps(); };
      i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
      i.addEventListener('blur', () => done(true)); i.addEventListener('click', (e) => e.stopPropagation());
    },
    async exportUser(id) {
      const g = this; const u = g.user.find((x) => x.id === id); const params = u ? u.params : g.stateOf(id); if (!params) return;
      let thumb = null; const cv = g.userThumbs[id] || g.thumbs[id]; if (cv && cv.tagName === 'CANVAS') { try { thumb = cv.toDataURL('image/png'); } catch (_) {} }
      const obj = { schema: 'lab-preset@1', tool: g.tool, name: u ? u.name : id, params, thumb };
      const a = el('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' })); a.download = (obj.name.replace(/[^\w-]+/g, '_') || 'look') + '.' + g.tool + '.preset.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },
    async importFile(f) {
      const g = this; let obj; try { obj = JSON.parse(await f.text()); } catch (_) { flash('Not a preset file'); return false; }
      if (!obj || obj.schema !== 'lab-preset@1' || !obj.params) { flash('Not a preset file'); return false; }
      if (obj.tool && obj.tool !== g.tool) { flash('Preset is for ' + obj.tool); return false; }
      const rec = await g.saveUser(obj.name || f.name.replace(/\.[^.]*$/, ''), obj.params);
      if (obj.thumb) { try { const b = await (await fetch(obj.thumb)).blob(); await LabStore.put('thumbs', g._key(rec.id), b); g._paintThumb(rec.id, b); } catch (_) {} }
      return true;
    },
    importPicker() { const i = el('input'); i.type = 'file'; i.accept = '.json,application/json'; i.onchange = () => { if (i.files[0]) this.importFile(i.files[0]); }; i.click(); },
    menu(id, isUser, x, y) {
      const g = this; const r = g.user.find((u) => u.id === id);
      const items = isUser ? [
        { title: 'Rename', onClick: () => g.rename(id) },
        { title: 'Update from current', onClick: () => g.updateUser(id) },
        { title: 'Duplicate', onClick: () => g.duplicate(id) },
        { title: r && r.fav ? 'Unfavourite' : 'Favourite', onClick: () => g.favourite(id) },
        { title: 'Export JSON', onClick: () => g.exportUser(id) },
        { sep: true },
        { title: 'Delete', danger: true, onClick: () => g.removeUser(id) },
      ] : [
        { title: 'Duplicate to mine', onClick: () => g.duplicate(id) },
        { title: 'Export JSON', onClick: () => g.exportUser(id) },
      ];
      contextMenu(x, y, items);
    },
  };
  Object.assign(PresetsControl.prototype, presetUser);

  // ---------------------------------------------------------------- look URLs: the params that differ from the defaults, deflated into #look=
  const b64u = { enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), dec: (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i); return u; } };
  async function deflate(text) { if (typeof CompressionStream === 'undefined') return 'j.' + b64u.enc(new TextEncoder().encode(text)); const buf = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(); return 'z.' + b64u.enc(buf); }
  async function inflate(s) { const kind = s.slice(0, 2), body = s.slice(2); const bytes = b64u.dec(body); if (kind === 'j.') return new TextDecoder().decode(bytes); return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text(); }
  Object.assign(Project.prototype, {
    diffFromDefaults(exclude) {
      const s = this.pane.getState(), d = this.pane.getDefaults(), out = {};
      Object.keys(s).forEach((r) => Object.keys(s[r]).forEach((k) => { const p = r + '.' + k; if (excluded(p, exclude)) return; if (JSON.stringify(s[r][k]) !== JSON.stringify(d[r] && d[r][k])) (out[r] = out[r] || {})[k] = s[r][k]; }));
      return out;
    },
    async lookToHash(exclude) { const obj = { schema: 'lab-look@1', tool: this.tool, params: this.diffFromDefaults(exclude || this.o.lookExclude) }; return '#look=' + await deflate(JSON.stringify(obj)); },
    async copyLook(exclude) {
      const hash = await this.lookToHash(exclude); const url = location.href.replace(/#.*$/, '') + hash;
      try { await navigator.clipboard.writeText(url); flash('Look link copied (' + url.length + ' chars)'); } catch (_) { global.prompt('Look link', url); }
      return url;
    },
    // apply a #look= from the current URL (one history entry), then strip it so a reload does not re-apply it over the autosave
    async applyHash(hash) {
      hash = hash != null ? hash : location.hash; const m = /[#&]look=([^&]+)/.exec(hash || ''); if (!m) return false;
      let obj; try { obj = JSON.parse(await inflate(decodeURIComponent(m[1]))); } catch (e) { flash('Bad look link'); return false; }
      if (!obj || obj.schema !== 'lab-look@1' || (obj.tool && obj.tool !== this.tool)) { flash('Look link is for ' + (obj && obj.tool)); return false; }
      const defaults = this.pane.getDefaults(); const full = {}; Object.keys(defaults).forEach((r) => { full[r] = Object.assign({}, defaults[r], (obj.params && obj.params[r]) || {}); });
      this.pane.setState(filterState(full, this.o.lookExclude), { label: 'Look from link', source: 'preset', kind: 'preset' });
      // strip the hash so a reload does not re-apply it over the autosave; after load, so the navigation itself completes first
      const strip = () => { try { global.history.replaceState(null, '', location.pathname + location.search); } catch (_) {} };
      if (doc.readyState === 'complete') strip(); else global.addEventListener('load', () => setTimeout(strip, 0), { once: true });
      this.emit('look', { params: obj.params }); return true;
    },
  });

  // ================================================================ viewer: zoom, pan, probe, guides, compare
  // shell.viewer.attach(canvas, { pane, source: () => ({el, w, h}) | null, fit: () => 'cover'|'contain', spacePan, hPan })
  // keys: 0 fit, 1 100 %, 2 200 %, mod+wheel zooms about the cursor, middle-drag (or Space / H held) pans,
  //       P probe (shift+click pins up to four), G guides (shift+G platform UI), \ held shows the source,
  //       shift+\ stores the current output as B, Y wipes A against B (alt+Y swaps sides).
  const GUIDES = [null, { name: '9:16', ar: 9 / 16 }, { name: '4:5', ar: 4 / 5 }, { name: '1:1', ar: 1 }, { name: 'title safe 90%', inset: 0.05 }, { name: 'action safe 93%', inset: 0.035 }];
  class Viewer extends Emitter {
    constructor(api) {
      super(); this.api = api; this.view = api.view; this.canvas = null; this.o = {};
      this.zoom = 'fit'; this.pan = { x: 0, y: 0 }; this.probe = { on: false, pins: [] }; this.guides = { mode: 0, ui: false }; this.compare = { mode: 'off', split: 0.5, swap: false, b: null };
      const L = this.layer = el('div', 'lab-viewer-layer'); L.hidden = true;
      this.cmp = el('canvas', 'lab-cmp'); this.cmpLabA = el('span', 'lab-cmp-label lab-cmp-a', 'A CURRENT'); this.cmpLabB = el('span', 'lab-cmp-label lab-cmp-b', 'SOURCE');
      this.divider = el('div', 'lab-cmp-divider'); this.guideBox = el('div', 'lab-guides'); this.guideLab = el('span', 'lab-guides-label'); this.uiBox = el('div', 'lab-guides-ui'); this.pinBox = el('div', 'lab-pins');
      this.guideBox.appendChild(this.guideLab); L.append(this.cmp, this.cmpLabA, this.cmpLabB, this.divider, this.guideBox, this.uiBox, this.pinBox);
      this.view.appendChild(L);
      this._raf = 0; this._drag = null; this._held = {};
      this.divider.addEventListener('pointerdown', (e) => { e.preventDefault(); this.divider.setPointerCapture(e.pointerId); this._dragDiv = true; });
      this.divider.addEventListener('pointermove', (e) => { if (!this._dragDiv) return; const r = this._rect(); this.compare.split = clamp((e.clientX - r.left) / r.width, 0.02, 0.98); this._layout(); });
      const endDiv = () => { this._dragDiv = false; this.emit('view'); }; this.divider.addEventListener('pointerup', endDiv); this.divider.addEventListener('pointercancel', endDiv);
    }
    attach(canvas, o) {
      this.canvas = canvas; this.o = o || {}; const v = this.view;
      canvas.classList.add('lab-zoom-target');
      // zoom about the cursor with mod+wheel; pan with the middle button, or a held Space / H
      v.addEventListener('wheel', (e) => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); const f = Math.pow(1.1, -e.deltaY / 100); this.setZoom((this.zoom === 'fit' ? this._fitFactor() : this.zoom) * f, e.clientX, e.clientY); }, { passive: false });
      v.addEventListener('pointerdown', (e) => {
        const held = (this.o.spacePan && this._held.Space) || (this.o.hPan && this._held.KeyH);
        if (e.button === 1 || (e.button === 0 && held)) { e.preventDefault(); e.stopPropagation(); this._drag = { x: e.clientX, y: e.clientY, px: this.pan.x, py: this.pan.y }; v.setPointerCapture(e.pointerId); return; }
        if (e.button === 0 && this.probe.on && e.shiftKey) { e.preventDefault(); e.stopPropagation(); this.addPin(e.clientX, e.clientY); }
      }, true);
      v.addEventListener('pointermove', (e) => {
        if (this._drag) { this.pan.x = this._drag.px + (e.clientX - this._drag.x); this.pan.y = this._drag.py + (e.clientY - this._drag.y); this._applyTransform(); return; }
        if (this.probe.on) this._probeAt(e.clientX, e.clientY);
      });
      const endDrag = (e) => { if (this._drag) { this._drag = null; try { v.releasePointerCapture(e.pointerId); } catch (_) {} this.emit('view'); } };
      v.addEventListener('pointerup', endDrag); v.addEventListener('pointercancel', endDrag);
      doc.addEventListener('keydown', (e) => {
        if (inText(e.target) || e.metaKey || e.ctrlKey) return;
        this._held[e.code] = true;
        if (e.code === 'Backslash' && !e.repeat) { e.preventDefault(); if (e.shiftKey) this.captureB(); else if (this.compare.mode === 'off') this.setCompare('source'); }
        if ((e.code === 'Space' && this.o.spacePan) || (e.code === 'KeyH' && this.o.hPan)) { if (e.target === v || v.contains(e.target) || e.target === doc.body) v.classList.add('lab-panning'); }
      });
      doc.addEventListener('keyup', (e) => {
        this._held[e.code] = false;
        if (e.code === 'Backslash' && this.compare.mode === 'source') this.setCompare('off');
        if (e.code === 'Space' || e.code === 'KeyH') v.classList.remove('lab-panning');
      });
      keys.bind('Digit0', '', () => this.setZoom('fit'), { label: 'Zoom to fit' });
      keys.bind('Digit1', '', () => this.setZoom(1), { label: 'Zoom 100%' });
      keys.bind('Digit2', '', () => this.setZoom(2), { label: 'Zoom 200%' });
      keys.bind('KeyP', '', () => this.setProbe(!this.probe.on), { label: 'Pixel probe' });
      keys.bind('KeyG', '', () => this.setGuides((this.guides.mode + 1) % GUIDES.length), { label: 'Cycle guides' });
      keys.bind('KeyG', 'shift', () => { this.guides.ui = !this.guides.ui; this._layout(); this.emit('view'); }, { label: 'Platform UI overlay' });
      keys.bind('KeyY', '', () => this.setCompare(this.compare.mode === 'wipe' ? 'off' : 'wipe'), { label: 'Split wipe' });
      keys.bind('KeyY', 'alt', () => { this.compare.swap = !this.compare.swap; this._layout(); this.emit('view'); }, { label: 'Swap wipe sides' });
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this._layout()).observe(canvas);
      this._layout();
      return this;
    }
    _rect() { return this.canvas.getBoundingClientRect(); }
    _viewRect() { return this.view.getBoundingClientRect(); }
    _dpr() { return global.devicePixelRatio || 1; }
    _fitFactor() { return 1; }
    // scale factor so that 1 output pixel = 1 device pixel at zoom 1
    _factor(z) { if (z === 'fit') return 1; const c = this.canvas; const cssW = c.clientWidth || 1; return z * (c.width / this._dpr()) / cssW; }
    setZoom(z, cx, cy) {
      const c = this.canvas; if (!c) return;
      if (z !== 'fit') z = clamp(+z || 1, 0.05, 16);
      const s0 = this._factor(this.zoom), s1 = this._factor(z);
      if (z === 'fit') { this.pan.x = 0; this.pan.y = 0; }
      else if (cx != null) { const r = this._rect(); const ccx = r.left + r.width / 2, ccy = r.top + r.height / 2; const px = (cx - ccx) / s0, py = (cy - ccy) / s0; this.pan.x += (s0 - s1) * px; this.pan.y += (s0 - s1) * py; }
      this.zoom = z; this._applyTransform(); this._layout();
      const sel = this.api._zoomSelect; if (sel) { const v = z === 'fit' ? 'fit' : String(Math.round(z * 100)); if ([...sel.options].some((o) => o.value === v)) sel.value = v; }
      this.emit('zoom', { zoom: z }); this.emit('view');
    }
    _applyTransform() { const c = this.canvas; if (!c) return; const s = this._factor(this.zoom); c.style.transform = (this.zoom === 'fit' && !this.pan.x && !this.pan.y) ? '' : `translate(${this.pan.x}px, ${this.pan.y}px) scale(${s})`; c.style.transformOrigin = '50% 50%'; this.view.classList.toggle('lab-zoomed', this.zoom !== 'fit'); }
    fit() { this.setZoom('fit'); }
    // canvas backing-pixel coordinates under a client point
    toCanvas(cx, cy) { const r = this._rect(), c = this.canvas; return { x: Math.floor((cx - r.left) / r.width * c.width), y: Math.floor((cy - r.top) / r.height * c.height) }; }
    readPixel(x, y) {
      const c = this.canvas; if (!c || x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
      if (this.o.readPixel) return this.o.readPixel(x, y);
      try { const t = this._rc || (this._rc = doc.createElement('canvas')); t.width = t.height = 1; const g = t.getContext('2d', { willReadFrequently: true }); g.clearRect(0, 0, 1, 1); g.drawImage(c, x, y, 1, 1, 0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3]]; } catch (_) { return null; }
    }
    static describe(x, y, px) { if (!px) return `x ${x} y ${y}  —`; const hex = '#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase(); const L = (0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]) / 255; return `x ${x} y ${y}  rgb ${px[0]} ${px[1]} ${px[2]}  ${hex}  L ${L.toFixed(2)}`; }
    setProbe(on) { this.probe.on = !!on; this.view.classList.toggle('lab-probing', this.probe.on); if (!this.probe.on) this._status(''); else this._status('probe: move over the canvas · shift+click pins'); this._layout(); this.emit('view'); }
    _probeAt(cx, cy) { const p = this.toCanvas(cx, cy); const px = this.readPixel(p.x, p.y); this.probe.last = { x: p.x, y: p.y, px }; this._status(Viewer.describe(p.x, p.y, px)); }
    _status(text) { const s = this.api.status; let cell = s.querySelector('.lab-probe-cell'); if (!cell) { cell = el('span', 'lab-cell lab-probe-cell'); s.appendChild(cell); } cell.textContent = text; cell.hidden = !text; }
    addPin(cx, cy) { const p = this.toCanvas(cx, cy); if (this.probe.pins.length >= 4) this.probe.pins.shift(); this.probe.pins.push({ x: p.x, y: p.y }); this._layout(); this.emit('view'); }
    clearPins() { this.probe.pins = []; this._layout(); this.emit('view'); }
    setGuides(mode) { this.guides.mode = clamp(mode | 0, 0, GUIDES.length - 1); this._layout(); flash(GUIDES[this.guides.mode] ? 'Guides: ' + GUIDES[this.guides.mode].name : 'Guides off'); this.emit('view'); }
    // B: a still of the current output plus a named history snapshot of the state
    captureB() {
      const c = this.canvas; if (!c) return;
      const b = doc.createElement('canvas'); b.width = c.width; b.height = c.height; try { b.getContext('2d').drawImage(c, 0, 0); } catch (_) { return; }
      this._bImage = b; const snap = this.o.pane ? this.o.pane.history.snapshot('B') : null;
      this.compare.b = { t: Date.now(), snapshot: snap ? snap.id : null, name: snap ? snap.name : 'B' };
      flash('B stored: ' + (this.o.label ? this.o.label() : 'current state')); this._layout(); this.emit('view');
    }
    setCompare(mode) { this.compare.mode = mode; this._layout(); if (mode !== 'off') this._tick(); this.emit('compare', { mode }); this.emit('view'); }
    _drawSource(g, w, h) {
      const s = this.o.source ? this.o.source() : null; if (!s || !s.el) { g.fillStyle = '#000'; g.fillRect(0, 0, w, h); return false; }
      const sw = s.w || s.el.videoWidth || s.el.naturalWidth || s.el.width || 1, sh = s.h || s.el.videoHeight || s.el.naturalHeight || s.el.height || 1;
      const fit = this.o.fit ? this.o.fit() : 'contain'; const sa = sw / sh, ca = w / h; let dw = w, dh = h;
      if (fit === 'cover' ? sa < ca : sa > ca) { dw = w; dh = w / sa; } else { dh = h; dw = h * sa; }
      g.fillStyle = '#000'; g.fillRect(0, 0, w, h); try { g.drawImage(s.el, (w - dw) / 2, (h - dh) / 2, dw, dh); } catch (_) { return false; }
      return true;
    }
    _tick() {
      cancelAnimationFrame(this._raf); if (this.compare.mode === 'off') return;
      const c = this.canvas, m = this.cmp; if (m.width !== c.width || m.height !== c.height) { m.width = c.width; m.height = c.height; }
      const g = m.getContext('2d'); g.clearRect(0, 0, m.width, m.height);
      const rightIsB = !this.compare.swap; const split = Math.round(this.compare.split * m.width);
      if (this.compare.mode === 'source') { this._drawSource(g, m.width, m.height); }
      else {
        g.save(); if (rightIsB) g.rect(split, 0, m.width - split, m.height); else g.rect(0, 0, split, m.height); g.clip();
        if (this._bImage) g.drawImage(this._bImage, 0, 0, m.width, m.height); else this._drawSource(g, m.width, m.height);
        g.restore();
      }
      if (this.compare.mode === 'source' || !this._bImage) this._raf = requestAnimationFrame(() => this._tick());   // live source: keep drawing
    }
    _layout() {
      const c = this.canvas, L = this.layer; if (!c) return;
      const on = this.compare.mode !== 'off' || this.guides.mode > 0 || this.guides.ui || this.probe.pins.length > 0;
      L.hidden = !on; if (!on) { this.guideBox.hidden = true; this.cmp.hidden = true; this.divider.hidden = true; return; }
      const r = this._rect(), vr = this._viewRect();
      L.style.left = (r.left - vr.left) + 'px'; L.style.top = (r.top - vr.top) + 'px'; L.style.width = r.width + 'px'; L.style.height = r.height + 'px';
      // compare
      const cm = this.compare.mode; this.cmp.hidden = cm === 'off'; this.divider.hidden = cm !== 'wipe'; this.cmpLabA.hidden = cm !== 'wipe'; this.cmpLabB.hidden = cm === 'off';
      if (cm === 'wipe') { const x = this.compare.split * r.width; this.divider.style.left = x + 'px'; const nm = this.compare.b && this.compare.b.name; const bName = this._bImage ? 'B ' + (nm && nm !== 'B' ? nm.toUpperCase() : 'SNAPSHOT') : 'SOURCE'; if (this.compare.swap) { this.cmpLabB.textContent = bName; this.cmpLabB.style.left = '6px'; this.cmpLabB.style.right = 'auto'; this.cmpLabA.style.right = '6px'; this.cmpLabA.style.left = 'auto'; } else { this.cmpLabB.textContent = bName; this.cmpLabB.style.right = '6px'; this.cmpLabB.style.left = 'auto'; this.cmpLabA.style.left = '6px'; this.cmpLabA.style.right = 'auto'; } }
      else if (cm === 'source') { this.cmpLabB.textContent = 'SOURCE'; this.cmpLabB.style.left = '6px'; this.cmpLabB.style.right = 'auto'; }
      // guides
      const gd = GUIDES[this.guides.mode]; this.guideBox.hidden = !gd;
      if (gd) { let w = r.width, h = r.height, x = 0, y = 0; if (gd.ar) { if (r.width / r.height > gd.ar) { w = r.height * gd.ar; x = (r.width - w) / 2; } else { h = r.width / gd.ar; y = (r.height - h) / 2; } } else { x = r.width * gd.inset; y = r.height * gd.inset; w = r.width - 2 * x; h = r.height - 2 * y; }
        Object.assign(this.guideBox.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' }); this.guideLab.textContent = gd.name; this.guideBox.dataset.ar = gd.ar ? gd.name : ''; }
      // platform ui for 9:16: caption zone (bottom 24 %) and action column (right 14 %)
      this.uiBox.hidden = !(this.guides.ui && gd && gd.ar === 9 / 16);
      if (!this.uiBox.hidden) { const gb = this.guideBox.style; this.uiBox.innerHTML = ''; const cap = el('div', 'lab-ui-zone lab-ui-cap'), col = el('div', 'lab-ui-zone lab-ui-col'); const w = parseFloat(gb.width), h = parseFloat(gb.height), x = parseFloat(gb.left), y = parseFloat(gb.top); Object.assign(cap.style, { left: x + 'px', top: (y + h * 0.76) + 'px', width: w + 'px', height: h * 0.24 + 'px' }); Object.assign(col.style, { left: (x + w * 0.86) + 'px', top: (y + h * 0.45) + 'px', width: w * 0.14 + 'px', height: h * 0.31 + 'px' }); this.uiBox.append(cap, col); }
      // pins
      this.pinBox.innerHTML = ''; this.probe.pins.forEach((p, i) => { const px = this.readPixel(p.x, p.y); const d = el('div', 'lab-pin'); d.style.left = (p.x / c.width * r.width) + 'px'; d.style.top = (p.y / c.height * r.height) + 'px'; d.append(el('i'), el('span', null, (i + 1) + ' ' + (px ? `${px[0]} ${px[1]} ${px[2]}` : '—'))); this.pinBox.appendChild(d); });
      if (this.probe.pins.length && !this._pinTimer) this._pinTimer = setInterval(() => { if (!this.probe.pins.length) { clearInterval(this._pinTimer); this._pinTimer = null; return; } this._layout(); }, 250);
    }
    getState() { return { zoom: this.zoom, pan: { x: this.pan.x, y: this.pan.y }, guides: { mode: this.guides.mode, ui: this.guides.ui }, pins: this.probe.pins.slice(), split: this.compare.split, swap: this.compare.swap }; }
    setState(s) { if (!s) return; if (s.zoom != null) this.zoom = s.zoom; if (s.pan) this.pan = { x: +s.pan.x || 0, y: +s.pan.y || 0 }; if (s.guides) this.guides = { mode: s.guides.mode | 0, ui: !!s.guides.ui }; if (Array.isArray(s.pins)) this.probe.pins = s.pins.slice(0, 4); if (s.split != null) this.compare.split = clamp(+s.split, 0.02, 0.98); this.compare.swap = !!s.swap; this._applyTransform(); this._layout(); }
  }

  // ================================================================ folder ops: bypass / solo (identity values), lock, seeded randomise
  function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  Object.assign(Folder.prototype, {
    // declare what this folder contributes when bypassed: { 'root.key': identityValue }
    setIdentity(map) {
      const pn = this.pane; if (!pn) throw new Error('setIdentity needs a pane'); this.identity = map || {};
      if (!pn._bypass) { pn._bypass = {}; }
      if (!(this.title in pn._bypass)) pn._bypass[this.title] = false;
      pn.track('bypass', pn._bypass);
      if (!this._bypassWired) { this._bypassWired = true; this.head.addEventListener('click', (e) => { if (!e.altKey) return; e.preventDefault(); e.stopPropagation(); if (e.shiftKey) pn.solo(this); else this.bypass = !this.bypass; }, true); this.head.title = 'alt+click: bypass · alt+shift+click: solo'; }
      pn._syncBypassUI(); return this;
    },

    // randomise the unlocked tracked bindings of this folder around their current values (deviation 1 = uniform over the range)
    randomise(o) {
      const pn = this.pane; if (!pn) return; o = o || {}; const dev = o.deviation != null ? o.deviation : pn.deviation; const rng = o.rng || pn.nextRng();
      const flat = {}; const seen = new Set();
      this.bindings().forEach((b) => { const p = b.path; if (!p || seen.has(p) || b.locked || b.opts.readonly) return; seen.add(p); const v = b.randomValue(rng, dev); if (v !== undefined && v !== b.value) flat[p] = v; });
      if (!Object.keys(flat).length) return;
      pn.setState(nest(flat), { label: 'Randomise ' + (this.title || 'folder') + ' ' + Math.round(dev * 100) + '%', source: 'random', kind: 'random' });
    },
  });
  Object.defineProperty(Folder.prototype, 'bypass', {
    get() { const pn = this.pane; return !!(pn && pn._bypass && pn._bypass[this.title]); },
    set(v) { const pn = this.pane; if (!pn || !this.identity) return; pn.setState({ bypass: { [this.title]: !!v } }, { label: (v ? 'Bypass ' : 'Enable ') + this.title, source: 'bypass', kind: 'bypass' }); },
  });
  Object.defineProperty(Binding.prototype, 'locked', {
    get() { return !!this._locked; },
    set(v) { this._locked = !!v; this.element.classList.toggle('lab-locked', this._locked); const pn = this.pane; if (pn && this.path) { if (this._locked) pn.locks.add(this.path); else pn.locks.delete(this.path); pn.emit('locks', { path: this.path, locked: this._locked }); } },
  });
  Object.defineProperty(Pane.prototype, 'locks', { get() { if (!this._locks) this._locks = new Set(); return this._locks; } });
  Object.assign(Binding.prototype, {
    randomValue(rng, dev) {
      const o = this.opts, cur = this.value; dev = clamp(dev == null ? 1 : dev, 0, 1);
      if (this.view === 'slider') { const min = o.min, max = o.max; if (typeof min !== 'number' || typeof max !== 'number') return undefined; let v = dev >= 1 ? min + rng() * (max - min) : cur + (rng() * 2 - 1) * dev * (max - min); v = clamp(v, min, max); const st = o.step || 0; if (st > 0) v = Math.round(v / st) * st; return +v.toFixed(Math.min(10, decimals(st || 0.01) + 2)); }
      if (this.view === 'list') { const opts = normalizeOptions(o.options); if (!opts.length) return undefined; if (dev < 1 && rng() > dev) return cur; return opts[Math.floor(rng() * opts.length)].value; }
      if (this.view === 'checkbox') { if (dev < 1 && rng() > dev) return cur; return rng() < 0.5; }
      if (this.view === 'color') { const rnd = '#' + Math.floor(rng() * 0xffffff).toString(16).padStart(6, '0'); return dev >= 1 ? rnd : lerpHex(String(cur), rnd, dev); }
      return undefined;
    },
  });
  Object.assign(Pane.prototype, {
    _syncBypassUI() { const m = this._bypass || {}; this.folders().forEach((f) => { if (f.identity) f.element.classList.toggle('lab-bypassed', !!m[f.title]); }); this._eff = null; },
    // overrides per root for the bypassed folders, cached until the next state event
    _overrides() {
      if (this._eff) return this._eff; const out = {}; const m = this._bypass || {};
      this.folders().forEach((f) => { if (f.identity && m[f.title]) Object.keys(f.identity).forEach((p) => { const i = p.indexOf('.'); (out[p.slice(0, i)] = out[p.slice(0, i)] || {})[p.slice(i + 1)] = f.identity[p]; }); });
      this._eff = out; return out;
    },
    bypassActive() { const m = this._bypass || {}; return Object.keys(m).some((k) => m[k]); },
    // the object the renderer should read: the root itself when nothing is bypassed, else a copy with the identity values applied
    effective(obj) { if (!this.bypassActive()) return obj; const r = this._rootName(obj); const ov = r && this._overrides()[r]; return ov ? Object.assign({}, obj, ov) : obj; },
    getEffectiveState() { const s = this.getState(); const ov = this._overrides(); Object.keys(ov).forEach((r) => { if (s[r]) Object.assign(s[r], ov[r]); }); return s; },
    solo(folder) {
      const m = this._bypass || {}; const ids = this.folders().filter((f) => f.identity);
      if (this._soloPrev && this._soloFolder === folder) { const prev = this._soloPrev; this._soloPrev = null; this._soloFolder = null; this.setState({ bypass: prev }, { label: 'Unsolo ' + folder.title, source: 'bypass', kind: 'bypass' }); return; }
      if (!this._soloPrev) this._soloPrev = Object.assign({}, m); this._soloFolder = folder;
      const next = {}; ids.forEach((f) => { next[f.title] = f !== folder; });
      this.setState({ bypass: next }, { label: 'Solo ' + folder.title, source: 'bypass', kind: 'bypass' });
    },
    setLocks(paths) { const set = new Set(paths || []); this.bindings().forEach((b) => { const p = b.path; if (p) b.locked = set.has(p); }); },
    nextRng() { this.rolls = (this.rolls | 0) + 1; return mulberry32(((this.seed | 0) ^ (this.rolls * 2654435761)) >>> 0); },
    randomiseAll(o) { const flat = {}; const seen = new Set(); const dev = (o && o.deviation != null) ? o.deviation : this.deviation; const rng = this.nextRng(); this.bindings().forEach((b) => { const p = b.path; if (!p || seen.has(p) || b.locked || b.opts.readonly || !b.folder || !b.folder.title) return; seen.add(p); const v = b.randomValue(rng, dev); if (v !== undefined && v !== b.value) flat[p] = v; }); if (Object.keys(flat).length) this.setState(nest(flat), { label: 'Randomise all ' + Math.round(dev * 100) + '%', source: 'random', kind: 'random' }); },
    // a Randomise folder (deviation, roll buttons) plus an RND action on every folder with tracked bindings
    addRandomise(o) {
      o = o || {}; if (this.deviation == null) this.deviation = o.deviation != null ? o.deviation : 0.25; if (this.seed == null) this.seed = (Math.random() * 0xffffffff) >>> 0;
      const f = this.addFolder({ title: o.title || 'Randomise', expanded: o.expanded === true });
      const R = this._rand = { deviation: this.deviation };
      f.addBinding(R, 'deviation', { label: 'deviation', min: 0, max: 1, step: 0.01, format: (v) => Math.round(v * 100) + '%' }).on('change', (ev) => { this.deviation = ev.value; });
      f.addButtons([{ title: 'roll folder', onClick: () => { const t = this.focusedFolder(); if (t) t.randomise(); else flash('Focus a control in a folder first'); } }, { title: 'roll all', onClick: () => this.randomiseAll() }], { cols: 2 });
      f.addNote('alt+click a label to lock it · shift+R rolls the focused folder · alt+click a folder dot to bypass it, alt+shift to solo');
      this.folders().forEach((x) => { if (x === f || !x.title || x.bindings().some((b) => !b.path) && !x.bindings().some((b) => b.path)) return; if (!x.bindings().some((b) => b.path)) return; if (x._rnd) return; const b = el('button', 'lab-rnd', 'rnd'); b.type = 'button'; b.title = 'randomise this folder (shift+R)'; b.addEventListener('click', (e) => { e.stopPropagation(); x.randomise(); }); x.headRight.appendChild(b); x._rnd = b; });
      keys.bind('KeyR', 'shift', () => { const t = this.focusedFolder(); if (t) t.randomise(); else this.randomiseAll(); }, { label: 'Randomise focused folder' });
      keys.bind('KeyB', '', () => { const t = this.focusedFolder(); if (t && t.identity) t.bypass = !t.bypass; }, { label: 'Bypass focused folder' });
      return f;
    },
  });

  global.LabUI = { Pane, Folder, Binding, PadControl, CurveControl, Viewer, History, Project, LabStore, keys, flash, lerpState, mulberry32, shell, dropTarget, fmt, el, enhance, icon, menubar, toolbar, bindTip, setLabel, ICONS };
})(window);
