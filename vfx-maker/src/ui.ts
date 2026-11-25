/* eslint-disable @typescript-eslint/no-explicit-any */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...children);
  return e;
}

export function button(label: string, cls = '', onClick?: () => void): HTMLButtonElement {
  const b = h('button', { class: cls, type: 'button' }, label);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export interface Control {
  sync(): void;
  row: HTMLElement;
}

/** 대상 객체(getter)의 속성에 연결되는 컨트롤 팩토리. 대상이 바뀌면 syncAll() 로 다시 읽는다. */
export class Form {
  controls: Control[] = [];
  constructor(
    private get: () => Record<string, any> | undefined,
    private onChange: (key: string) => void,
  ) {}

  section(parent: HTMLElement, title: string, open = true, sub = false): HTMLElement {
    const body = h('div', { class: 'section-body' });
    const det = h('details', { class: sub ? 'section sub' : 'section' }, h('summary', {}, title), body);
    if (open) det.open = true;
    parent.appendChild(det);
    return body;
  }

  private add(parent: HTMLElement, row: HTMLElement, sync: () => void): Control {
    parent.appendChild(row);
    const c = { row, sync };
    this.controls.push(c);
    sync();
    return c;
  }

  slider(parent: HTMLElement, label: string, key: string, min: number, max: number, step: number, fmt: (v: number) => string = (v) => String(v)): Control {
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
    const out = h('output');
    const row = h('label', { class: 'row' }, h('span', { class: 'lbl' }, label), input, out);
    input.addEventListener('input', () => {
      const t = this.get();
      if (!t) return;
      t[key] = Number(input.value);
      out.textContent = fmt(t[key]);
      this.onChange(key);
    });
    return this.add(parent, row, () => {
      const t = this.get();
      if (!t) return;
      input.value = String(t[key]);
      out.textContent = fmt(t[key]);
    });
  }

  number(parent: HTMLElement, label: string, key: string, min: number, max: number, step = 1): Control {
    const input = h('input', { type: 'number', min: String(min), max: String(max), step: String(step) });
    const row = h('label', { class: 'row' }, h('span', { class: 'lbl' }, label), input);
    input.addEventListener('change', () => {
      const t = this.get();
      if (!t) return;
      const v = Math.min(max, Math.max(min, Number(input.value) || 0));
      t[key] = v;
      input.value = String(v);
      this.onChange(key);
    });
    return this.add(parent, row, () => {
      const t = this.get();
      if (t) input.value = String(t[key]);
    });
  }

  select(parent: HTMLElement, label: string, key: string, options: [string, string][]): Control {
    const sel = h('select');
    for (const [v, t] of options) sel.appendChild(h('option', { value: v }, t));
    const row = h('label', { class: 'row' }, h('span', { class: 'lbl' }, label), sel);
    sel.addEventListener('change', () => {
      const t = this.get();
      if (!t) return;
      t[key] = typeof t[key] === 'number' ? Number(sel.value) : sel.value;
      this.onChange(key);
    });
    return this.add(parent, row, () => {
      const t = this.get();
      if (t) sel.value = String(t[key]);
    });
  }

  check(parent: HTMLElement, label: string, key: string): Control {
    const input = h('input', { type: 'checkbox' });
    const row = h('label', { class: 'row check' }, input, h('span', {}, label));
    input.addEventListener('change', () => {
      const t = this.get();
      if (!t) return;
      t[key] = input.checked;
      this.onChange(key);
    });
    return this.add(parent, row, () => {
      const t = this.get();
      if (t) input.checked = !!t[key];
    });
  }

  color(parent: HTMLElement, label: string, key: string): Control {
    const input = h('input', { type: 'color' });
    const row = h('label', { class: 'row' }, h('span', { class: 'lbl' }, label), input);
    input.addEventListener('input', () => {
      const t = this.get();
      if (!t) return;
      t[key] = input.value;
      this.onChange(key);
    });
    return this.add(parent, row, () => {
      const t = this.get();
      if (t) input.value = t[key];
    });
  }

  text(parent: HTMLElement, label: string, key: string): Control {
    const input = h('input', { type: 'text', spellcheck: 'false' });
    const row = h('label', { class: 'row' }, h('span', { class: 'lbl' }, label), input);
    input.addEventListener('input', () => {
      const t = this.get();
      if (!t) return;
      t[key] = input.value;
      this.onChange(key);
    });
    return this.add(parent, row, () => {
      const t = this.get();
      if (t) input.value = t[key];
    });
  }

  textarea(parent: HTMLElement, label: string, key: string): Control {
    const ta = h('textarea', { rows: '3', spellcheck: 'false' });
    const row = h('label', { class: 'row col' }, h('span', { class: 'lbl' }, label), ta);
    ta.addEventListener('input', () => {
      const t = this.get();
      if (!t) return;
      t[key] = ta.value;
      this.onChange(key);
    });
    return this.add(parent, row, () => {
      const t = this.get();
      if (t) ta.value = t[key];
    });
  }

  syncAll(): void {
    this.controls.forEach((c) => c.sync());
  }
}
