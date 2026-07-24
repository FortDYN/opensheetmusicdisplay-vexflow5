/**
 * ScorePlayer — self-contained multi-part score widget.
 *
 * Renders all parts of a ScoreData JSON model stacked per measure column
 * (part order, beat-aligned via a unified Formatter) and provides:
 *  - a toolbar with transport state, playback speed, font zoom (re-layout)
 *    and background presets;
 *  - a collapsible "Tracks" panel with per-part controls: volume, pan,
 *    reverb, notation type (staff/jianpu/tab), measure numbers, chords.
 *
 * Audio parameters are a data model only: they live in PlaybackState and are
 * broadcast via onPlaybackStateChange so an audio engine can hook in later.
 */

import {
  NotationType,
  PartData,
  PlaybackState,
  ScoreData,
} from "./ScoreData";
import {
  RenderOptions,
  ScoreRenderPart,
  renderScore,
} from "./ScoreRenderEngine";
import { partToRenderData } from "./ScoreDataAdapter";

export interface ScorePlayerOptions {
  fontSize?: number;           // initial digit font size, default 16
  background?: string;         // initial background key, default "white"
  layout?: "auto" | number;    // "auto" = content-driven packing; number = fixed measures per line
  onPlaybackStateChange?: (state: PlaybackState) => void;
}

interface PartView {
  data: PartData;
  notation: NotationType;
  options: { showMeasureNumbers: boolean, showChords: boolean };
}

const BACKGROUNDS: { key: string, label: string, color: string }[] = [
  { key: "white", label: "White", color: "#ffffff" },
  { key: "parchment", label: "Parchment", color: "#f7ecd7" },
  { key: "lightblue", label: "Light Blue", color: "#e9f1fa" },
];

const NOTATIONS: { key: NotationType, label: string }[] = [
  { key: "staff", label: "Staff" },
  { key: "jianpu", label: "Jianpu" },
  { key: "tab", label: "Tab" },
];

const MIN_FS: number = 10;
const MAX_FS: number = 28;

export class ScorePlayer {
  private container: HTMLElement;
  private scoreData: ScoreData;
  private options: ScorePlayerOptions;
  private fontSize: number;
  private background: string;
  private parts: PartView[] = [];
  private playback: PlaybackState;
  private scoreEl: HTMLElement = null;
  private tracksEl: HTMLElement = null;
  private tracksToggle: HTMLButtonElement = null;
  private tracksCollapsed = false;
  private resizeObserver: ResizeObserver = null;
  private lastLayoutWidth = 0;
  private layout: "auto" | number;

  private static stylesInjected = false;

  constructor(container: HTMLElement, data: ScoreData, options?: ScorePlayerOptions) {
    this.container = container;
    this.scoreData = data;
    this.options = options || {};
    this.fontSize = this.clampFs(this.options.fontSize || 16);
    this.background = this.options.background || "white";
    this.layout = this.options.layout != null ? this.options.layout : "auto";
    this.playback = {
      playing: false,
      bpm: data.global.bpm,
      speed: 1,
      parts: data.parts.map(p => ({
        partId: p.id,
        volume: p.instrument.volume,
        pan: p.instrument.pan,
        reverb: p.instrument.reverb,
      })),
    };

    ScorePlayer.injectStyles();
    this.build();
  }

  // ── Public API ────────────────────────────────────────────────

  /** 0.5..2 (clamped). Data-model only — no audio. */
  public setSpeed(speed: number): void {
    this.playback.speed = Math.min(2, Math.max(0.5, speed));
    const slider: HTMLInputElement = this.container.querySelector<HTMLInputElement>(".osp-speed");
    const label: HTMLElement = this.container.querySelector<HTMLElement>(".osp-speed-val");
    if (slider) {slider.value = String(Math.round(this.playback.speed * 100));}
    if (label) {label.textContent = Math.round(this.playback.speed * 100) + "%";}
    this.emitPlayback();
  }

  /** 10..28 (clamped). Re-lays out the whole score. */
  public setFontSize(fs: number): void {
    this.fontSize = this.clampFs(fs);
    this.renderScoreCombined();
  }

  public setBackground(key: string): void {
    if (!BACKGROUNDS.some(b => b.key === key)) {return;}
    this.background = key;
    this.applyBackground();
  }

  public setPartNotation(partId: string, notation: NotationType): void {
    const part: PartView = this.parts.find((p: PartView) => p.data.id === partId);
    if (!part) {return;}
    part.notation = notation;
    const select: HTMLSelectElement = this.container.querySelector<HTMLSelectElement>(`.osp-notation[data-part="${partId}"]`);
    if (select) {select.value = notation;}
    this.renderScoreCombined();
  }

  public getPlaybackState(): PlaybackState {
    return JSON.parse(JSON.stringify(this.playback));
  }

  /**
   * "auto": every measure column takes its natural content width and lines
   * are packed by available container width. A number: fixed measures per
   * line (line width still grows to fit the densest measure).
   */
  public setLayout(layout: "auto" | number): void {
    this.layout = layout;
    const select: HTMLSelectElement = this.container.querySelector<HTMLSelectElement>(".osp-layout");
    if (select) {select.value = String(layout);}
    this.renderScoreCombined();
  }

  /** Full rebuild (toolbar + tracks panel + score). */
  public render(): void {
    this.build();
  }

  // ── Construction ──────────────────────────────────────────────

  private clampFs(fs: number): number {
    return Math.min(MAX_FS, Math.max(MIN_FS, fs));
  }

  private build(): void {
    this.parts = this.scoreData.parts.map(pd => ({
      data: pd,
      notation: pd.notation,
      options: {
        showMeasureNumbers: pd.options.showMeasureNumbers,
        showChords: pd.options.showChords,
      },
    }));

    this.container.innerHTML = "";
    this.container.classList.add("osp-root");
    this.container.appendChild(this.buildToolbar());

    this.tracksEl = document.createElement("div");
    this.tracksEl.className = "osp-tracks";
    for (const view of this.parts) {
      this.tracksEl.appendChild(this.buildTrackRow(view));
    }
    this.container.appendChild(this.tracksEl);

    this.scoreEl = document.createElement("div");
    this.scoreEl.className = "osp-score";
    this.container.appendChild(this.scoreEl);

    this.applyTracksCollapsed();
    this.applyBackground();
    this.renderScoreCombined();

    // Re-layout when the container's width changes (window resize etc.).
    // Guarded by lastLayoutWidth so height-only changes don't re-render.
    this.resizeObserver = new ResizeObserver(() => {
      const w: number = this.scoreEl ? this.scoreEl.clientWidth : 0;
      if (w > 0 && w !== this.lastLayoutWidth) {this.renderScoreCombined();}
    });
    this.resizeObserver.observe(this.scoreEl);
  }

  private buildToolbar(): HTMLElement {
    const bar: HTMLDivElement = document.createElement("div");
    bar.className = "osp-toolbar";

    // Transport (state only — no audio)
    const transport: HTMLSpanElement = document.createElement("span");
    transport.className = "osp-group";
    for (const t of ["Play", "Pause", "Stop"]) {
      const btn: HTMLButtonElement = document.createElement("button");
      btn.className = "osp-btn osp-transport";
      btn.dataset.action = t.toLowerCase();
      btn.textContent = t;
      btn.addEventListener("click", () => this.onTransport(btn, t.toLowerCase()));
      transport.appendChild(btn);
    }
    bar.appendChild(transport);

    // Speed
    const speed: HTMLSpanElement = document.createElement("span");
    speed.className = "osp-group";
    const speedLabel: HTMLSpanElement = document.createElement("span");
    speedLabel.className = "osp-label";
    speedLabel.textContent = "Speed";
    const speedSlider: HTMLInputElement = document.createElement("input");
    speedSlider.type = "range";
    speedSlider.className = "osp-speed";
    speedSlider.min = "50";
    speedSlider.max = "200";
    speedSlider.step = "5";
    speedSlider.value = "100";
    const speedVal: HTMLSpanElement = document.createElement("span");
    speedVal.className = "osp-val osp-speed-val";
    speedVal.textContent = "100%";
    speedSlider.addEventListener("input", () => {
      this.playback.speed = parseInt(speedSlider.value, 10) / 100;
      speedVal.textContent = speedSlider.value + "%";
      this.emitPlayback();
    });
    speed.append(speedLabel, speedSlider, speedVal);
    bar.appendChild(speed);

    // Font zoom
    const font: HTMLSpanElement = document.createElement("span");
    font.className = "osp-group";
    const fontLabel: HTMLSpanElement = document.createElement("span");
    fontLabel.className = "osp-label";
    fontLabel.textContent = "Font";
    const fontOut: HTMLButtonElement = document.createElement("button");
    fontOut.className = "osp-btn";
    fontOut.textContent = "A−";
    fontOut.addEventListener("click", () => this.setFontSize(this.fontSize - 2));
    const fontIn: HTMLButtonElement = document.createElement("button");
    fontIn.className = "osp-btn";
    fontIn.textContent = "A+";
    fontIn.addEventListener("click", () => this.setFontSize(this.fontSize + 2));
    font.append(fontLabel, fontOut, fontIn);
    bar.appendChild(font);

    // Layout mode: auto (content-driven) or fixed measures per line
    const layout: HTMLSpanElement = document.createElement("span");
    layout.className = "osp-group";
    const layoutLabel: HTMLSpanElement = document.createElement("span");
    layoutLabel.className = "osp-label";
    layoutLabel.textContent = "Layout";
    const layoutSel: HTMLSelectElement = document.createElement("select");
    layoutSel.className = "osp-layout";
    for (const opt of [{ v: "auto", t: "Auto" }, { v: "1", t: "1 / line" }, { v: "2", t: "2 / line" },
                       { v: "3", t: "3 / line" }, { v: "4", t: "4 / line" }, { v: "6", t: "6 / line" },
                       { v: "8", t: "8 / line" }]) {
      const o: HTMLOptionElement = document.createElement("option");
      o.value = opt.v;
      o.textContent = opt.t;
      layoutSel.appendChild(o);
    }
    layoutSel.value = String(this.layout);
    layoutSel.addEventListener("change", () => {
      this.setLayout(layoutSel.value === "auto" ? "auto" : parseInt(layoutSel.value, 10));
    });
    layout.append(layoutLabel, layoutSel);
    bar.appendChild(layout);

    // Background swatches
    const bg: HTMLSpanElement = document.createElement("span");
    bg.className = "osp-group";
    const bgLabel: HTMLSpanElement = document.createElement("span");
    bgLabel.className = "osp-label";
    bgLabel.textContent = "Background";
    bg.appendChild(bgLabel);
    for (const preset of BACKGROUNDS) {
      const sw: HTMLButtonElement = document.createElement("button");
      sw.className = "osp-swatch";
      sw.dataset.bg = preset.key;
      sw.title = preset.label;
      sw.style.background = preset.color;
      sw.addEventListener("click", () => this.setBackground(preset.key));
      bg.appendChild(sw);
    }
    bar.appendChild(bg);

    // Tracks panel toggle (right-aligned)
    this.tracksToggle = document.createElement("button");
    this.tracksToggle.className = "osp-btn osp-tracks-toggle";
    this.tracksToggle.addEventListener("click", () => {
      this.tracksCollapsed = !this.tracksCollapsed;
      this.applyTracksCollapsed();
    });
    bar.appendChild(this.tracksToggle);

    return bar;
  }

  private applyTracksCollapsed(): void {
    if (this.tracksEl) {this.tracksEl.style.display = this.tracksCollapsed ? "none" : "";}
    if (this.tracksToggle) {
      this.tracksToggle.textContent = this.tracksCollapsed ? "Tracks ▸" : "Tracks ▾";
      this.tracksToggle.classList.toggle("osp-active", !this.tracksCollapsed);
    }
  }

  private buildTrackRow(view: PartView): HTMLElement {
    const row: HTMLDivElement = document.createElement("div");
    row.className = "osp-track";

    const name: HTMLSpanElement = document.createElement("span");
    name.className = "osp-track-name";
    name.textContent = view.data.name || view.data.id;
    row.appendChild(name);

    // Notation select
    row.appendChild(this.labeled("Notation", ((): HTMLSelectElement => {
      const sel: HTMLSelectElement = document.createElement("select");
      sel.className = "osp-notation";
      sel.dataset.part = view.data.id;
      for (const n of NOTATIONS) {
        const opt: HTMLOptionElement = document.createElement("option");
        opt.value = n.key;
        opt.textContent = n.label;
        sel.appendChild(opt);
      }
      sel.value = view.notation;
      sel.addEventListener("change", () => this.setPartNotation(view.data.id, sel.value as NotationType));
      return sel;
    })()));

    // Volume / pan / reverb sliders (playback state only)
    row.appendChild(this.sliderControl("Vol", 0, 100, view.data.instrument.volume * 100,
      v => { this.partPlayback(view.data.id).volume = v / 100; }));
    row.appendChild(this.sliderControl("Pan", -100, 100, view.data.instrument.pan * 100,
      v => { this.partPlayback(view.data.id).pan = v / 100; }));
    row.appendChild(this.sliderControl("Rev", 0, 100, view.data.instrument.reverb * 100,
      v => { this.partPlayback(view.data.id).reverb = v / 100; }));

    // Display option checkboxes
    row.appendChild(this.checkboxControl("Measure No.", view.options.showMeasureNumbers, checked => {
      view.options.showMeasureNumbers = checked;
      this.renderScoreCombined();
    }));
    row.appendChild(this.checkboxControl("Chords", view.options.showChords, checked => {
      view.options.showChords = checked;
      this.renderScoreCombined();
    }));

    return row;
  }

  // ── Control helpers ───────────────────────────────────────────

  private labeled(text: string, control: HTMLElement): HTMLElement {
    const wrap: HTMLLabelElement = document.createElement("label");
    wrap.className = "osp-field";
    const span: HTMLSpanElement = document.createElement("span");
    span.className = "osp-label";
    span.textContent = text;
    wrap.append(span, control);
    return wrap;
  }

  private sliderControl(
    label: string, min: number, max: number, initial: number,
    apply: (v: number) => void
  ): HTMLElement {
    const input: HTMLInputElement = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.value = String(Math.round(initial));
    const val: HTMLSpanElement = document.createElement("span");
    val.className = "osp-val";
    val.textContent = String(Math.round(initial));
    input.addEventListener("input", () => {
      const v: number = parseInt(input.value, 10);
      val.textContent = input.value;
      apply(v);
      this.emitPlayback();
    });
    return this.labeled(label, ((): HTMLSpanElement => {
      const box: HTMLSpanElement = document.createElement("span");
      box.className = "osp-slider-box";
      box.append(input, val);
      return box;
    })());
  }

  private checkboxControl(label: string, initial: boolean, apply: (checked: boolean) => void): HTMLElement {
    const wrap: HTMLLabelElement = document.createElement("label");
    wrap.className = "osp-field osp-check";
    const input: HTMLInputElement = document.createElement("input");
    input.type = "checkbox";
    input.checked = initial;
    input.addEventListener("change", () => apply(input.checked));
    const span: HTMLSpanElement = document.createElement("span");
    span.className = "osp-label";
    span.textContent = label;
    wrap.append(input, span);
    return wrap;
  }

  private onTransport(btn: HTMLButtonElement, action: string): void {
    this.playback.playing = action === "play";
    for (const b of this.container.querySelectorAll(".osp-transport")) {
      b.classList.toggle("osp-active", b === btn && action === "play");
    }
    this.emitPlayback();
  }

  private partPlayback(partId: string): { partId: string, volume: number, pan: number, reverb: number } {
    return this.playback.parts.find(p => p.partId === partId);
  }

  private emitPlayback(): void {
    if (this.options.onPlaybackStateChange) {
      this.options.onPlaybackStateChange(this.getPlaybackState());
    }
  }

  private applyBackground(): void {
    const preset: { key: string, label: string, color: string } =
      BACKGROUNDS.find((b: { key: string, label: string, color: string }) => b.key === this.background);
    this.container.style.background = preset ? preset.color : "#ffffff";
    for (const sw of this.container.querySelectorAll<HTMLElement>(".osp-swatch")) {
      sw.classList.toggle("osp-active", sw.dataset.bg === this.background);
    }
  }

  // ── Rendering ─────────────────────────────────────────────────

  private renderScoreCombined(): void {
    if (!this.scoreEl) {return;}
    try {
      const renderParts: ScoreRenderPart[] = this.parts.map(p => ({
        notation: p.notation,
        data: partToRenderData(p.data, this.scoreData.global, p.notation, this.fontSize),
        showChords: p.options.showChords,
        showMeasureNumbers: p.options.showMeasureNumbers,
      }));
      const opts: RenderOptions = { digitFontSize: this.fontSize };
      if (this.layout !== "auto") {
        // Fixed perLine: width floor still font-scaled; the engine widens
        // any line whose densest measure needs more room.
        opts.perLine = this.layout;
        opts.measureWidth = this.fontSize * 16;
      }
      this.lastLayoutWidth = this.scoreEl.clientWidth;
      renderScore(this.scoreEl, renderParts, opts);
    } catch (e) {
      this.scoreEl.innerHTML = '<div class="osp-err">Cannot render score: ' + (e.message || e) + "</div>";
    }
  }

  // ── Styles (injected once per page) ───────────────────────────

  private static injectStyles(): void {
    if (ScorePlayer.stylesInjected) {return;}
    ScorePlayer.stylesInjected = true;
    const style: HTMLStyleElement = document.createElement("style");
    style.textContent = [
      ".osp-root{font-family:sans-serif;border-radius:8px;padding:12px 16px;box-shadow:0 2px 4px rgba(0,0,0,0.1);transition:background .2s}",
      ".osp-toolbar{display:flex;flex-wrap:wrap;gap:16px;align-items:center;padding:6px 0 10px;border-bottom:1px solid rgba(0,0,0,0.12)}",
      ".osp-group{display:inline-flex;align-items:center;gap:6px}",
      ".osp-label{font-size:12px;color:#555}",
      ".osp-btn{padding:4px 12px;border:1px solid #bbb;border-radius:4px;background:#fff;font-size:12px;cursor:pointer;color:#333}",
      ".osp-btn:hover{background:#f0f0f0}",
      ".osp-btn.osp-active{background:#2b6cb0;border-color:#2b6cb0;color:#fff}",
      ".osp-tracks-toggle{margin-left:auto}",
      ".osp-val{font-size:12px;color:#333;min-width:34px;display:inline-block;text-align:right}",
      ".osp-swatch{width:18px;height:18px;border:1px solid #999;border-radius:4px;cursor:pointer;padding:0}",
      ".osp-swatch.osp-active{outline:2px solid #2b6cb0;outline-offset:1px}",
      ".osp-tracks{padding:4px 0 8px;border-bottom:1px solid rgba(0,0,0,0.08)}",
      ".osp-track{display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:5px 0;border-bottom:1px dashed rgba(0,0,0,0.06)}",
      ".osp-track:last-child{border-bottom:none}",
      ".osp-track-name{font-size:13px;font-weight:bold;color:#222;min-width:72px}",
      ".osp-field{display:inline-flex;align-items:center;gap:5px}",
      ".osp-field select{font-size:12px;padding:2px 4px}",
      ".osp-slider-box{display:inline-flex;align-items:center;gap:4px}",
      ".osp-slider-box input[type=range]{width:72px}",
      ".osp-check input{margin:0}",
      ".osp-score{padding:6px 0;overflow-x:auto}",
      ".osp-err{color:#c00;font-family:monospace;font-size:12px;padding:8px;background:#fee;border-radius:4px}",
      ".osp-root svg{display:block}",
    ].join("\n");
    document.head.appendChild(style);
  }
}
