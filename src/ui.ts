import { Settings } from './types';

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

type NumKeys = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BoolKeys = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
type StrKeys = { [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings];

export interface Control {
  /** 설정값을 UI 에 다시 반영 */
  sync(): void;
  row: HTMLElement;
}

/** 설정과 연결된 컨트롤을 만드는 팩토리. */
export class Form {
  controls: Control[] = [];
  constructor(
    private s: Settings,
    private onChange: (key: keyof Settings) => void,
  ) {}

  section(parent: HTMLElement, title: string, open = true): HTMLElement {
    const body = h('div', { class: 'section-body' });
    const det = h('details', { class: 'section' }, h('summary', {}, title), body);
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

  slider(
    parent: HTMLElement,
    label: string,
    key: NumKeys,
    min: number,
    max: number,
    step: number,
    fmt: (v: number) => string = (v) => String(v),
  ): Control {
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
    const out = h('output');
    const row = h('label', { class: 'row' }, h('span', { class: 'lbl' }, label), input, out);
    input.addEventListener('input', () => {
      (this.s[key] as number) = Number(input.value);
      out.textContent = fmt(this.s[key] as number);
      this.onChange(key);
    });
    return this.add(parent, row, () => {
      input.value = String(this.s[key]);
      out.textContent = fmt(this.s[key] as number);
    });
  }

  number(parent: HTMLElement, label: string, key: NumKeys, min: number, max: number, step = 1): Control {
    const input = h('input', { type: 'number', min: String(min), max: String(max), step: String(step) });
    const row = h('label', { class: 'row' }, h('span', { class: 'lbl' }, label), input);
    input.addEventListener('change', () => {
      const v = Math.min(max, Math.max(min, Number(input.value) || min));
      (this.s[key] as number) = v;
      input.value = String(v);
      this.onChange(key);
    });
    return this.add(parent, row, () => (input.value = String(this.s[key])));
  }

  select<K extends StrKeys | NumKeys>(
    parent: HTMLElement,
    label: string,
    key: K,
    options: [string, string][],
  ): Control {
    const sel = h('select');
    for (const [v, t] of options) sel.appendChild(h('option', { value: v }, t));
    const row = h('label', { class: 'row' }, h('span', { class: 'lbl' }, label), sel);
    const isNum = typeof this.s[key] === 'number';
    sel.addEventListener('change', () => {
      (this.s as unknown as Record<string, unknown>)[key] = isNum ? Number(sel.value) : sel.value;
      this.onChange(key);
    });
    return this.add(parent, row, () => (sel.value = String(this.s[key])));
  }

  check(parent: HTMLElement, label: string, key: BoolKeys): Control {
    const input = h('input', { type: 'checkbox' });
    const row = h('label', { class: 'row check' }, input, h('span', {}, label));
    input.addEventListener('change', () => {
      (this.s[key] as boolean) = input.checked;
      this.onChange(key);
    });
    return this.add(parent, row, () => (input.checked = this.s[key] as boolean));
  }

  color(parent: HTMLElement, label: string, key: StrKeys): Control {
    const input = h('input', { type: 'color' });
    const row = h('label', { class: 'row' }, h('span', { class: 'lbl' }, label), input);
    input.addEventListener('input', () => {
      (this.s[key] as string) = input.value;
      this.onChange(key);
    });
    return this.add(parent, row, () => (input.value = this.s[key] as string));
  }

  textarea(parent: HTMLElement, label: string, key: StrKeys): Control {
    const ta = h('textarea', { rows: '3', spellcheck: 'false' });
    const row = h('label', { class: 'row col' }, h('span', { class: 'lbl' }, label), ta);
    ta.addEventListener('input', () => {
      (this.s[key] as string) = ta.value;
      this.onChange(key);
    });
    return this.add(parent, row, () => (ta.value = this.s[key] as string));
  }

  syncAll(): void {
    this.controls.forEach((c) => c.sync());
  }
}

export function button(label: string, cls = '', onClick?: () => void): HTMLButtonElement {
  const b = h('button', { class: cls, type: 'button' }, label);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
