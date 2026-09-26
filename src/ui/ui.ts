// Binds the static markup in index.html to the settings store. Controls are
// declared with data attributes, so adding a control is a line of HTML:
//   data-setting="key"   range / checkbox / color / textarea bound to Settings[key]
//   data-readout="key"   formatted value
//   data-choice="key"    group of [data-value] buttons (radio semantics)
//   data-action="name"   button that calls actions[name]()

import { PRESETS, RANGES, type Settings } from '../settings';

type Actions = Record<string, (el: HTMLElement) => void>;

const FORMAT: Partial<Record<keyof Settings, (v: number) => string>> = {
  size: (v) => v.toFixed(2),
  tracking: (v) => (v >= 0 ? '+' : '') + v.toFixed(3),
  depth: (v) => v.toFixed(2),
  bevel: (v) => v.toFixed(3),
  accentRatio: (v) => `${Math.round(v * 100)}%`,
  gravity: (v) => `${v.toFixed(2)} g`,
  wind: (v) => (v === 0 ? 'calm' : `${v > 0 ? '→' : '←'} ${Math.abs(v).toFixed(2)}`),
  fan: (v) => v.toFixed(2),
  bounce: (v) => v.toFixed(2),
  friction: (v) => v.toFixed(2),
};

export class UI {
  private toastTimer = 0;
  private readonly toastEl = document.getElementById('toast')!;

  constructor(
    private readonly get: () => Settings,
    private readonly set: (patch: Partial<Settings>, opts?: { quiet?: boolean }) => void,
    private readonly actions: Actions,
  ) {
    this.bindSettings();
    this.bindChoices();
    this.bindActions();
    this.buildPresets();
    this.bindSheet();
    this.sync();
  }

  private bindSettings() {
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-setting]').forEach((el) => {
      const key = el.dataset.setting as keyof Settings;
      if (el instanceof HTMLInputElement && el.type === 'range') {
        const r = RANGES[key as keyof typeof RANGES];
        el.min = String(r.min);
        el.max = String(r.max);
        el.step = String(r.step);
      }
      const read = (): Partial<Settings> => {
        if (el instanceof HTMLInputElement && el.type === 'checkbox') return { [key]: el.checked };
        if (el instanceof HTMLInputElement && el.type === 'range') return { [key]: Number(el.value) };
        return { [key]: el.value };
      };
      el.addEventListener('input', () => {
        this.set(read());
        if (el instanceof HTMLInputElement && el.type === 'range') this.paintRange(el);
        this.syncReadouts();
      });
      // Keep typing on the canvas from triggering shortcuts, and let Esc blur.
      el.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if ((e as KeyboardEvent).key === 'Escape') (el as HTMLElement).blur();
      });
    });
  }

  private bindChoices() {
    document.querySelectorAll<HTMLElement>('[data-choice]').forEach((group) => {
      const key = group.dataset.choice as keyof Settings;
      group.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-value]');
        if (!b) return;
        this.set({ [key]: b.dataset.value } as Partial<Settings>);
        this.sync();
      });
      // Arrow keys move between options, like a native radio group.
      group.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const opts = [...group.querySelectorAll<HTMLButtonElement>('[data-value]:not([hidden])')];
        const i = opts.findIndex((o) => o.getAttribute('aria-checked') === 'true');
        const next = opts[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + opts.length) % opts.length];
        next.click();
        next.focus();
      });
    });
  }

  private bindActions() {
    document.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!el) return;
      const fn = this.actions[el.dataset.action!];
      if (fn) {
        e.preventDefault();
        fn(el);
      }
    });
  }

  private buildPresets() {
    const bar = document.getElementById('presets')!;
    PRESETS.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.action = `preset:${p.id}`;
      b.title = `${p.hint} (${i + 1})`;
      b.innerHTML = `${p.label}<kbd>${i + 1}</kbd>`;
      bar.appendChild(b);
    });
  }

  /** Mobile bottom sheet: drag the grabber down to dismiss. */
  private bindSheet() {
    const panel = document.getElementById('panel')!;
    const grab = panel.querySelector<HTMLElement>('.grabber')!;
    let start = -1;
    let dy = 0;
    grab.addEventListener('pointerdown', (e) => {
      start = e.clientY;
      dy = 0;
      grab.setPointerCapture(e.pointerId);
      panel.style.transition = 'none';
    });
    grab.addEventListener('pointermove', (e) => {
      if (start < 0) return;
      dy = Math.max(0, e.clientY - start);
      panel.style.transform = `translateY(${dy}px)`;
    });
    const end = () => {
      if (start < 0) return;
      start = -1;
      panel.style.transition = '';
      panel.style.transform = '';
      if (dy > 70) this.actions.tune(grab);
    };
    grab.addEventListener('pointerup', end);
    grab.addEventListener('pointercancel', end);
  }

  private paintRange(el: HTMLInputElement) {
    const p = ((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100;
    el.style.setProperty('--p', `${p}%`);
  }

  private syncReadouts() {
    const s = this.get();
    document.querySelectorAll<HTMLElement>('[data-readout]').forEach((o) => {
      const key = o.dataset.readout as keyof Settings;
      const v = s[key] as number;
      o.textContent = FORMAT[key]?.(v) ?? String(v);
    });
  }

  /** Push the current settings into every control. */
  sync() {
    const s = this.get();
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-setting]').forEach((el) => {
      const key = el.dataset.setting as keyof Settings;
      const v = s[key];
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(v);
      else if (document.activeElement !== el || el.type !== 'textarea') el.value = String(v);
      if (el instanceof HTMLInputElement && el.type === 'range') this.paintRange(el);
    });
    document.querySelectorAll<HTMLElement>('[data-choice]').forEach((group) => {
      const v = String(s[group.dataset.choice as keyof Settings]);
      group.querySelectorAll<HTMLButtonElement>('[data-value]').forEach((b) => {
        const on = b.dataset.value === v;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      });
    });
    this.syncReadouts();
  }

  toast(msg: string, ms = 2200) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('on'), ms);
  }
}
