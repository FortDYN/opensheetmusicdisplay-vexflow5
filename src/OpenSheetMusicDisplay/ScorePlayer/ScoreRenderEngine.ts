/**
 * ScoreRenderEngine — notation renderers for ScorePlayer.
 *
 * Ported from the proven demo renderers (demo/osmd-dev.html) and typed for
 * OSMD source. One notation type per part: staff / jianpu / tab.
 *
 * Layout rule (project-wide): every spacing constant scales linearly with
 * the digit font size via s(fs, v) — no font-independent magic numbers,
 * except documented VexFlow internals (STAFF_* / STEM_HEIGHT / TAB_*).
 */

import * as VF from "vexflow";
import { NotationType } from "./ScoreData";

// ── Shared types ────────────────────────────────────────────────

export interface RenderLyric {
  text: string;
  noteIndex: number;
}

export interface RenderMeasure {
  // jianpu
  notes?: VF.JianpuNote[];
  beams?: VF.JianpuBeam[];
  tuplets?: VF.Tuplet[];
  lyrics?: RenderLyric[];
  // staff
  staffNotes?: VF.StaveNote[];
  staffBeams?: VF.Beam[];
  staffTuplets?: VF.Tuplet[];
  // tab
  tabNotes?: VF.TabNote[];
  // shared
  numBeats: number;
  beatValue: number;
  measureNumber?: number; // displayed number (defaults to index + 1)
}

export interface RenderChord {
  measureIndex: number;
  chord: string;
}

export interface RenderData {
  measures: RenderMeasure[];
  ties?: VF.StaveTie[];       // jianpu ties
  staffTies?: VF.StaveTie[];  // staff ties
  chords?: RenderChord[];
}

export interface RenderOptions {
  digitFontSize?: number;        // default 14; all spacing scales from this
  perLine?: number;              // default 4
  measureWidth?: number;         // default s(fs, 220/240)
  lyrics?: boolean;              // jianpu only, default true
  showChords?: boolean;          // default false
  showMeasureNumbers?: boolean;  // default true
  staffJianpuPadding?: number;   // combined layouts only
}

/** Linear scale: convert a value calibrated at fs=14 to the current fs. */
function s(fs: number, v: number): number {
  return (fs * v) / 14;
}

function measureLabel(m: RenderMeasure, index: number): string {
  return String(m.measureNumber != null ? m.measureNumber : index + 1);
}

// ══════════════════════════════════════════════════════════════
//  Guitar chord shapes / diagrams
// ══════════════════════════════════════════════════════════════

export interface ChordPosition {
  str: number;            // 1 = high E (bottom of tab), 6 = low E (top)
  fret: number | string;  // 0 = open, "X" = muted
}

/** Standard guitar chord shapes → VexFlow TabNote positions. */
export function getChordPositions(chord: string): ChordPosition[] {
  const shapes: { [chord: string]: ChordPosition[] } = {
    "C":  [{ str: 5, fret: 3 }, { str: 4, fret: 2 }, { str: 3, fret: 0 }, { str: 2, fret: 1 }, { str: 1, fret: 0 }],
    "G":  [{ str: 6, fret: 3 }, { str: 5, fret: 2 }, { str: 4, fret: 0 }, { str: 3, fret: 0 }, { str: 2, fret: 0 }, { str: 1, fret: 3 }],
    "F":  [{ str: 6, fret: 1 }, { str: 5, fret: 3 }, { str: 4, fret: 3 }, { str: 3, fret: 2 }, { str: 2, fret: 1 }, { str: 1, fret: 1 }],
    "Am": [{ str: 5, fret: 0 }, { str: 4, fret: 2 }, { str: 3, fret: 2 }, { str: 2, fret: 1 }, { str: 1, fret: 0 }],
    "Dm": [{ str: 4, fret: 0 }, { str: 3, fret: 2 }, { str: 2, fret: 3 }, { str: 1, fret: 1 }],
    "Em": [{ str: 6, fret: 0 }, { str: 5, fret: 2 }, { str: 4, fret: 2 }, { str: 3, fret: 0 }, { str: 2, fret: 0 }, { str: 1, fret: 0 }],
    "Bm": [{ str: 5, fret: 2 }, { str: 4, fret: 4 }, { str: 3, fret: 4 }, { str: 2, fret: 4 }, { str: 1, fret: 2 }],
  };
  return shapes[chord] || [];
}

interface BarreInfo {
  fret: number;
  fromString: number; // lower pitch (left on diagram)
  toString: number;   // higher pitch (right on diagram)
}

/** Detect a barre (大横按): the lowest non-open fret pressed on 2+ strings. */
function detectBarre(positions: ChordPosition[]): BarreInfo {
  const fretted: ChordPosition[] = positions.filter((p: ChordPosition) => typeof p.fret === "number" && (p.fret as number) > 0);
  if (fretted.length < 2) {return null;}
  const minFret: number = Math.min(...fretted.map((p: ChordPosition) => p.fret as number));
  const barreStrings: number[] = fretted.filter((p: ChordPosition) => p.fret === minFret).map((p: ChordPosition) => p.str);
  if (barreStrings.length < 2) {return null;}
  return {
    fret: minFret,
    fromString: Math.max(...barreStrings),
    toString: Math.min(...barreStrings),
  };
}

/**
 * Draw a guitar chord diagram (fretboard grid with finger positions).
 * (x, y) is the top-left of the diagram; returns the total height drawn.
 */
export function drawChordDiagram(
  ctx: VF.RenderContext, x: number, y: number, fs: number,
  positions: ChordPosition[], chordName: string
): number {
  const u: (v: number) => number = (v: number): number => s(fs, v);
  const STRING_COUNT: number = 6;
  const FRET_COUNT: number = 4;
  const CELL_W: number = u(7);       // string spacing
  const CELL_H: number = u(9);       // fret spacing
  const LINE_W: number = u(0.6);     // grid line width
  const DOT_R: number = u(3.2);      // finger dot radius
  const NAME_FS: number = u(11);     // chord name font size
  const NAME_H: number = u(14);      // chord name area height
  const NUT_H: number = u(2.4);      // nut bar height
  const BARRE_H: number = u(4.5);    // barre bar height

  const gridW: number = CELL_W * (STRING_COUNT - 1);
  const gridH: number = CELL_H * FRET_COUNT;
  const totalH: number = NAME_H + NUT_H + gridH;

  // Chord name (top, centered)
  if (chordName) {
    ctx.save();
    ctx.setFont({ family: "sans-serif", size: NAME_FS, weight: "bold", style: "normal" });
    ctx.setFillStyle("black");
    const nameY: number = y + NAME_H - u(3);
    ctx.fillText(chordName, x + gridW / 2 - ctx.measureText(chordName).width / 2, nameY);
    ctx.restore();
  }

  const gridY: number = y + NAME_H;

  // Nut (thick top bar — open chords start at fret 1)
  ctx.save();
  ctx.setFillStyle("black");
  ctx.fillRect(x, gridY, gridW, NUT_H);
  ctx.restore();

  // Strings (vertical) and frets (horizontal)
  ctx.save();
  ctx.setFillStyle("black");
  for (let i: number = 0; i < STRING_COUNT; i++) {
    ctx.fillRect(x + i * CELL_W, gridY, LINE_W, gridH);
  }
  for (let i: number = 1; i <= FRET_COUNT; i++) {
    ctx.fillRect(x, gridY + i * CELL_H, gridW, LINE_W);
  }
  ctx.restore();

  // Barre (auto-detected): thick horizontal bar across the barred strings
  const barre: BarreInfo = detectBarre(positions);
  ctx.save();
  ctx.setFillStyle("black");
  if (barre) {
    const leftIdx: number = STRING_COUNT - barre.fromString;
    const rightIdx: number = STRING_COUNT - barre.toString;
    const barreX: number = x + leftIdx * CELL_W - DOT_R;
    const barreW: number = (rightIdx - leftIdx) * CELL_W + DOT_R * 2;
    const barreY: number = gridY + NUT_H + (barre.fret - 0.5) * CELL_H;
    ctx.fillRect(barreX, barreY - BARRE_H / 2, barreW, BARRE_H);
  }
  ctx.restore();

  // Finger dots / mute marks (open strings render nothing)
  ctx.save();
  ctx.setFillStyle("black");
  for (const pos of positions) {
    const stringIndex: number = STRING_COUNT - pos.str; // str 6 → 0 (left), str 1 → 5 (right)
    const dotX: number = x + stringIndex * CELL_W;
    if (pos.fret === "X" || pos.fret === "x") {
      ctx.setFont({ family: "sans-serif", size: NAME_FS * 0.8, weight: "normal" });
      ctx.fillText("×", dotX - u(3), gridY - u(2));
    } else if (pos.fret === 0) {
      // open string: no marker (by design)
    } else {
      const isBarred: boolean = barre && pos.fret === barre.fret;
      if (!isBarred) {
        const fret: number = typeof pos.fret === "number" ? pos.fret : parseInt(pos.fret as string, 10);
        const dotY: number = gridY + NUT_H + (fret - 0.5) * CELL_H;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R, 0, Math.PI * 2, false);
        ctx.fill();
      }
    }
  }
  ctx.restore();

  return totalH;
}

// ══════════════════════════════════════════════════════════════
//  Jianpu renderer (简谱)
// ══════════════════════════════════════════════════════════════

export function renderJianpu(container: HTMLElement, data: RenderData, opts?: RenderOptions): void {
  opts = opts || {};
  const fs: number = opts.digitFontSize || 14;
  const u: (v: number) => number = (v: number): number => s(fs, v);

  const showLyrics: boolean = opts.lyrics !== false;
  const showChords: boolean = opts.showChords === true && !!data.chords;
  const showMeasureNumbers: boolean = opts.showMeasureNumbers !== false;
  const measures: RenderMeasure[] = data.measures;
  const ties: VF.StaveTie[] = data.ties || [];
  const perLine: number = opts.perLine || 4;
  const measureWidth: number = opts.measureWidth || u(220);

  // All vertical / padding spacings derived from font size.
  const LYRICS_GAP: number      = u(25);  // digit baseline → lyrics baseline
  const CHORD_GAP: number       = u(20);  // stave top → chord baseline
  const MEASURE_NUM_FS: number  = u(10);  // measure-number font size
  const LYRICS_FS: number       = u(14);  // lyrics font size (matches digit size at fs=14)
  const CHORD_FS: number        = fs;     // chord symbol uses digit font size
  const TOP_PADDING: number     = u(20);
  const BOTTOM_PADDING: number  = u(20);
  const SIDE_PADDING: number    = u(10);
  const FORMATTER_PAD: number   = u(20);
  const STAVE_EXTRA: number     = u(10);  // extra slack inside JianpuStave visual height

  // JianpuStave visual barline height = 4 * spacing (spacing = fs*15/7 = 30 at fs=14).
  const staveVisualHeight: number = u(30) * 2 + STAVE_EXTRA;

  let lineHeight: number = staveVisualHeight;
  if (showLyrics) {lineHeight += LYRICS_GAP + fs;}
  if (showChords) {lineHeight += CHORD_GAP + fs;}

  const lineCount: number = Math.ceil(measures.length / perLine);
  const width: number = perLine * measureWidth + SIDE_PADDING * 2;
  const height: number = lineCount * lineHeight + TOP_PADDING + BOTTOM_PADDING;

  container.innerHTML = "";
  const div: HTMLDivElement = document.createElement("div");
  const renderer: VF.Renderer = new VF.Renderer(div, VF.RendererBackends.SVG);
  renderer.resize(width, height);
  const ctx: VF.RenderContext = renderer.getContext();

  for (let line: number = 0; line < lineCount; line++) {
    const lineStart: number = line * perLine;
    const lineEnd: number = Math.min(lineStart + perLine, measures.length);
    const y: number = TOP_PADDING + (showChords ? CHORD_GAP + fs : 0) + line * lineHeight;

    for (let i: number = lineStart; i < lineEnd; i++) {
      const m: RenderMeasure = measures[i];
      const x: number = SIDE_PADDING + (i - lineStart) * measureWidth;
      const isFirstInLine: boolean = (i - lineStart) === 0;

      const stave: VF.JianpuStave = new VF.JianpuStave(x, y, measureWidth, { leftBar: isFirstInLine, digitFontSize: fs });
      stave.setContext(ctx).draw();

      for (const n of m.notes) {n.setStave(stave);}

      const voice: VF.Voice = new VF.Voice({ numBeats: m.numBeats, beatValue: m.beatValue });
      voice.setStrict(false);
      voice.addTickables(m.notes);

      const formatter: VF.Formatter = new VF.Formatter();
      formatter.joinVoices([voice]);
      formatter.format([voice], measureWidth - FORMATTER_PAD);

      voice.setContext(ctx).draw();
      for (const b of m.beams) { b.setContext(ctx).draw(); }
      for (const t of m.tuplets) { t.setContext(ctx).draw(); }

      // Chord symbols: 2 high-octave-dots of clearance above the highest note.
      if (showChords) {
        const chord: RenderChord = data.chords.find((c: RenderChord) => c.measureIndex === i);
        if (chord) {
          let highestTopY: number = Infinity;
          for (const n of m.notes) {
            const ext: { topY: number, baseY: number } = n.getStemExtents();
            if (ext && ext.topY < highestTopY) {highestTopY = ext.topY;}
          }
          if (highestTopY === Infinity) {highestTopY = stave.getTopLineTopY();}
          const twoOctaveDotsSpace: number = 2 * (2 * (fs / 7) + (fs / 7));
          ctx.save();
          ctx.setFont({ family: "sans-serif", size: CHORD_FS, weight: "bold", style: "normal" });
          ctx.setFillStyle("black");
          const chordX: number = x + measureWidth / 2;
          const chordY: number = highestTopY - twoOctaveDotsSpace;
          ctx.fillText(chord.chord, chordX - ctx.measureText(chord.chord).width / 2, chordY);
          ctx.restore();
        }
      }

      // Lyrics (below digit baseline)
      if (showLyrics && m.lyrics.length > 0) {
        ctx.save();
        ctx.setFont({ family: "serif", size: LYRICS_FS, weight: "normal", style: "normal" });
        ctx.setFillStyle("black");
        for (const ly of m.lyrics) {
          if (ly.noteIndex < m.notes.length) {
            const jn: VF.JianpuNote = m.notes[ly.noteIndex];
            const nx: number = jn.getAbsoluteX() + jn.getDigitWidth() / 2;
            const ny: number = m.notes[0].getDigitBaselineY() + LYRICS_GAP;
            ctx.fillText(ly.text, nx - ctx.measureText(ly.text).width / 2, ny);
          }
        }
        ctx.restore();
      }

      // Measure number — barline x+2, baseline one digit-width above barline top.
      if (showMeasureNumbers) {
        const barlineTopY: number = Math.min(stave.getTopLineTopY(), stave.getBottomLineBottomY());
        ctx.save();
        ctx.setFont({ family: "sans-serif", size: MEASURE_NUM_FS, weight: "normal", style: "normal" });
        ctx.setFillStyle("#999");
        const numText: string = measureLabel(m, i);
        const numW: number = ctx.measureText(numText).width;
        ctx.fillText(numText, x + u(2), barlineTopY - numW);
        ctx.restore();
      }
    }
  }

  for (const tie of ties) {
    try { tie.setContext(ctx).draw(); } catch (e) { console.warn("Tie draw error:", e); }
  }

  container.appendChild(div);
}

// ══════════════════════════════════════════════════════════════
//  Staff renderer (五线谱)
// ══════════════════════════════════════════════════════════════

export function renderStaff(container: HTMLElement, data: RenderData, opts?: RenderOptions): void {
  opts = opts || {};
  const fs: number = opts.digitFontSize || 14;
  const u: (v: number) => number = (v: number): number => s(fs, v);

  const measures: RenderMeasure[] = data.measures;
  const showChords: boolean = opts.showChords === true && !!data.chords;
  const showMeasureNumbers: boolean = opts.showMeasureNumbers !== false;
  const perLine: number = opts.perLine || 4;
  const measureWidth: number = opts.measureWidth || u(240);

  const MEASURE_NUM_FS: number  = u(10);
  const CHORD_GAP: number       = u(10);  // stem top → chord baseline
  const TOP_PADDING: number     = u(10);
  const BOTTOM_PADDING: number  = u(20);
  const SIDE_PADDING: number    = u(10);
  const FORMATTER_PAD: number   = u(20);
  const LINE_GAP: number        = u(20);

  // VexFlow internals (font-independent staff geometry).
  const STAFF_SPACING: number   = 10;  // Tables.STAVE_LINE_DISTANCE
  const STAFF_SPACE_ABOVE: number = 4;
  const STAFF_NUM_LINES: number = 5;
  const STAFF_HEIGHT: number    = (STAFF_SPACE_ABOVE + STAFF_NUM_LINES) * STAFF_SPACING;
  const STEM_HEIGHT: number     = 35;  // Tables.STEM_HEIGHT

  const chordSpace: number = showChords ? STEM_HEIGHT + CHORD_GAP + fs : 0;
  const lineHeight: number = chordSpace + STAFF_HEIGHT + STEM_HEIGHT + LINE_GAP;

  const lineCount: number = Math.ceil(measures.length / perLine);
  const width: number = perLine * measureWidth + SIDE_PADDING * 2;
  const height: number = lineCount * lineHeight + TOP_PADDING + BOTTOM_PADDING;

  container.innerHTML = "";
  const div: HTMLDivElement = document.createElement("div");
  const renderer: VF.Renderer = new VF.Renderer(div, VF.RendererBackends.SVG);
  renderer.resize(width, height);
  const ctx: VF.RenderContext = renderer.getContext();

  for (let line: number = 0; line < lineCount; line++) {
    const lineStart: number = line * perLine;
    const lineEnd: number = Math.min(lineStart + perLine, measures.length);
    const yBase: number = TOP_PADDING + chordSpace + line * lineHeight;

    for (let i: number = lineStart; i < lineEnd; i++) {
      const m: RenderMeasure = measures[i];
      const x: number = SIDE_PADDING + (i - lineStart) * measureWidth;
      const isFirstInLine: boolean = (i - lineStart) === 0;

      const staffStave: VF.Stave = new VF.Stave(x, yBase, measureWidth, { leftBar: isFirstInLine });
      for (const n of m.staffNotes) {n.setStave(staffStave);}

      const staffVoice: VF.Voice = new VF.Voice({ numBeats: m.numBeats, beatValue: m.beatValue });
      staffVoice.setStrict(false);
      staffVoice.addTickables(m.staffNotes);
      const formatter: VF.Formatter = new VF.Formatter();
      formatter.format([staffVoice], measureWidth - FORMATTER_PAD);

      staffStave.setContext(ctx).draw();
      staffVoice.setContext(ctx).draw();
      for (const b of m.staffBeams) { b.setContext(ctx).draw(); }
      for (const t of m.staffTuplets) { t.setContext(ctx).draw(); }

      // Chord names above the staff, clear of up-stems.
      if (showChords) {
        const chord: RenderChord = data.chords.find((c: RenderChord) => c.measureIndex === i);
        if (chord) {
          let highestTopY: number = staffStave.getTopLineTopY();
          for (const sn of m.staffNotes) {
            if (sn.isRest()) {continue;}
            const ys: number[] = sn.getYs();
            if (ys && ys.length > 0) {highestTopY = Math.min(highestTopY, Math.min(...ys));}
          }
          ctx.save();
          ctx.setFont({ family: "sans-serif", size: fs, weight: "bold", style: "normal" });
          ctx.setFillStyle("black");
          const chordX: number = x + measureWidth / 2;
          const chordY: number = highestTopY - STEM_HEIGHT - CHORD_GAP;
          ctx.fillText(chord.chord, chordX - ctx.measureText(chord.chord).width / 2, chordY);
          ctx.restore();
        }
      }

      // Measure number — barline x+2, baseline one digit-width above barline top.
      if (showMeasureNumbers) {
        const barlineTopY: number = staffStave.getTopLineTopY();
        ctx.save();
        ctx.setFont({ family: "sans-serif", size: MEASURE_NUM_FS, weight: "normal", style: "normal" });
        ctx.setFillStyle("#999");
        const numText: string = measureLabel(m, i);
        const numW: number = ctx.measureText(numText).width;
        ctx.fillText(numText, x + u(2), barlineTopY - numW);
        ctx.restore();
      }
    }
  }

  for (const tie of (data.staffTies || [])) {
    try { tie.setContext(ctx).draw(); } catch (e) { console.warn("Staff tie:", e); }
  }

  container.appendChild(div);
}

// ══════════════════════════════════════════════════════════════
//  Tab renderer (吉他谱) — chord diagrams optional above each measure
// ══════════════════════════════════════════════════════════════

export function renderTab(container: HTMLElement, data: RenderData, opts?: RenderOptions): void {
  opts = opts || {};
  const fs: number = opts.digitFontSize || 14;
  const u: (v: number) => number = (v: number): number => s(fs, v);

  const measures: RenderMeasure[] = data.measures;
  const showChords: boolean = opts.showChords === true && !!data.chords && data.chords.length > 0;
  const showMeasureNumbers: boolean = opts.showMeasureNumbers !== false;
  const perLine: number = opts.perLine || 4;
  const measureWidth: number = opts.measureWidth || u(240);

  const MEASURE_NUM_FS: number  = u(10);
  const TOP_PADDING: number     = u(20);
  const BOTTOM_PADDING: number  = u(20);
  const SIDE_PADDING: number    = u(10);
  const FORMATTER_PAD: number   = u(20);
  const LINE_GAP: number        = u(20);
  const DIAGRAM_GAP: number     = u(3);

  // Chord diagram dimensions — must match drawChordDiagram() constants.
  const DIAGRAM_STRING_COUNT: number = 6;
  const DIAGRAM_FRET_COUNT: number = 4;
  const DIAGRAM_CELL_W: number = u(7);
  const DIAGRAM_CELL_H: number = u(9);
  const DIAGRAM_NAME_H: number = u(14);
  const DIAGRAM_NUT_H: number = u(2.4);
  const DIAGRAM_WIDTH: number = DIAGRAM_CELL_W * (DIAGRAM_STRING_COUNT - 1);
  const DIAGRAM_HEIGHT: number = DIAGRAM_NAME_H + DIAGRAM_NUT_H + DIAGRAM_CELL_H * DIAGRAM_FRET_COUNT;

  // TabStave geometry — VexFlow defaults (font-independent).
  const TAB_LINE_SPACING: number  = 13;
  const TAB_NUM_LINES: number     = 6;
  const TAB_SPACE_ABOVE: number   = 1;
  const TAB_SPACE_BELOW: number   = 1;
  const TAB_HEIGHT: number = (TAB_SPACE_ABOVE + TAB_NUM_LINES + TAB_SPACE_BELOW) * TAB_LINE_SPACING;

  const diagramSpace: number = showChords ? DIAGRAM_HEIGHT + DIAGRAM_GAP : 0;
  const lineHeight: number = diagramSpace + TAB_HEIGHT + LINE_GAP;

  const lineCount: number = Math.ceil(measures.length / perLine);
  const width: number = perLine * measureWidth + SIDE_PADDING * 2;
  const height: number = lineCount * lineHeight + TOP_PADDING + BOTTOM_PADDING;

  container.innerHTML = "";
  const div: HTMLDivElement = document.createElement("div");
  const renderer: VF.Renderer = new VF.Renderer(div, VF.RendererBackends.SVG);
  renderer.resize(width, height);
  const ctx: VF.RenderContext = renderer.getContext();

  for (let line: number = 0; line < lineCount; line++) {
    const lineStart: number = line * perLine;
    const lineEnd: number = Math.min(lineStart + perLine, measures.length);
    const yBase: number = TOP_PADDING + line * lineHeight;

    for (let i: number = lineStart; i < lineEnd; i++) {
      const m: RenderMeasure = measures[i];
      const x: number = SIDE_PADDING + (i - lineStart) * measureWidth;
      const isFirstInLine: boolean = (i - lineStart) === 0;

      const yTab: number = yBase + diagramSpace;
      const tabStave: VF.TabStave = new VF.TabStave(x, yTab, measureWidth, {
        leftBar: isFirstInLine, rightBar: true,
        spaceAboveStaffLn: TAB_SPACE_ABOVE, spaceBelowStaffLn: TAB_SPACE_BELOW,
      });

      for (const n of m.tabNotes) {n.setStave(tabStave);}
      const tabVoice: VF.Voice = new VF.Voice({ numBeats: m.numBeats, beatValue: m.beatValue });
      tabVoice.setStrict(false);
      tabVoice.addTickables(m.tabNotes);
      const formatter: VF.Formatter = new VF.Formatter();
      formatter.format([tabVoice], measureWidth - FORMATTER_PAD);

      tabStave.setContext(ctx).draw();
      tabVoice.setContext(ctx).draw();

      // Measure number — barline x+2, baseline one digit-width above barline top.
      if (showMeasureNumbers) {
        const tabBarlineTopY: number = tabStave.getTopLineTopY();
        ctx.save();
        ctx.setFont({ family: "sans-serif", size: MEASURE_NUM_FS, weight: "normal", style: "normal" });
        ctx.setFillStyle("#999");
        const numText: string = measureLabel(m, i);
        const numW: number = ctx.measureText(numText).width;
        ctx.fillText(numText, x + u(2), tabBarlineTopY - numW);
        ctx.restore();
      }

      // Chord diagram AFTER VexFlow staves, isolated in its own SVG group
      // (VexFlow SVGContext state conflicts otherwise).
      if (showChords) {
        const chord: RenderChord = data.chords.find((c: RenderChord) => c.measureIndex === i);
        if (chord) {
          const positions: ChordPosition[] = getChordPositions(chord.chord);
          const diagramX: number = x + (measureWidth - DIAGRAM_WIDTH) / 2;
          const yDiagram: number = yBase;
          ctx.openGroup("chord-diagram", "chord-diag-tab-" + i);
          drawChordDiagram(ctx, diagramX, yDiagram, fs, positions, chord.chord);
          ctx.closeGroup();
        }
      }
    }
  }

  container.appendChild(div);
}

// ══════════════════════════════════════════════════════════════
//  Combined multi-part renderer
//  Stacks every part's stave per measure column in part order and
//  beat-aligns them via one unified Formatter pass (like the proven
//  tab+jianpu / staff+jianpu demo layouts).
// ══════════════════════════════════════════════════════════════

export interface ScoreRenderPart {
  notation: NotationType;
  data: RenderData;
  showChords: boolean;
  showMeasureNumbers: boolean;
}

/**
 * Combined multi-part renderer.
 *
 * Stacks every part's stave per measure column in part order and beat-aligns
 * them via one unified Formatter pass.
 *
 * Layout modes (mutually exclusive, driven by RenderOptions):
 *  - Fixed (`opts.perLine` set): N measures per line; every line's measure
 *    width = max(opts.measureWidth, widest natural width in that line), so
 *    dense measures never overflow and barlines stay aligned within a line.
 *  - Dynamic (`opts.perLine` omitted): each measure column gets its natural
 *    width from VexFlow (Formatter.preCalculateMinTotalWidth — the true
 *    content extent, e.g. dense 32nd-note runs), and measures are packed
 *    greedily into lines by the container's available width.
 */
export function renderScore(container: HTMLElement, parts: ScoreRenderPart[], opts?: RenderOptions): void {
  opts = opts || {};
  const fs: number = opts.digitFontSize || 14;
  const u: (v: number) => number = (v: number): number => s(fs, v);

  const MEASURE_NUM_FS: number  = u(10);
  const LYRICS_GAP: number      = u(25);  // digit baseline → lyrics baseline
  const LYRICS_FS: number       = u(14);
  const TOP_PADDING: number     = u(20);
  const BOTTOM_PADDING: number  = u(20);
  const SIDE_PADDING: number    = u(10);
  const FORMATTER_PAD: number   = u(20);
  const PART_GAP: number        = u(12);  // vertical gap between stacked parts
  const LINE_GAP: number        = u(20);
  const CHORD_NAME_GAP: number  = u(20);  // strip height for chord names
  const DIAGRAM_GAP: number     = u(3);
  const MIN_COLUMN_W: number    = u(60);  // floor for a measure's natural width

  // Staff geometry — VexFlow internals (font-independent).
  const STAFF_HEIGHT: number = (4 + 5) * 10;  // (spaceAbove + numLines) * STAVE_LINE_DISTANCE
  const STEM_HEIGHT: number  = 35;            // down-stem extension below the staff
  const TAB_HEIGHT: number   = (1 + 6 + 1) * 13; // (spaceAbove + numLines + spaceBelow) * spacing

  // Chord diagram dimensions — must match drawChordDiagram() constants.
  const DIAGRAM_WIDTH: number = u(7) * 5;
  const DIAGRAM_HEIGHT: number = u(14) + u(2.4) + u(9) * 4;

  // JianpuStave visual height (same formula as renderJianpu).
  const jianpuVisualHeight: number = u(30) * 2 + u(10);

  // Per-part block heights and lyrics strips.
  const blockHeight: (p: ScoreRenderPart) => number = (p: ScoreRenderPart): number => {
    if (p.notation === "staff") {return STAFF_HEIGHT + STEM_HEIGHT;}
    if (p.notation === "tab") {return TAB_HEIGHT;}
    return jianpuVisualHeight;
  };
  const hasLyrics: (p: ScoreRenderPart) => boolean = (p: ScoreRenderPart): boolean =>
    p.notation === "jianpu" && p.data.measures.some((m: RenderMeasure) => (m.lyrics || []).length > 0);
  const lyricsStrip: (p: ScoreRenderPart) => number = (p: ScoreRenderPart): number => (hasLyrics(p) ? LYRICS_GAP + fs : 0);

  // Chord strip: first part (in order) with chords enabled supplies the symbols.
  const chordSource: ScoreRenderPart = parts.find((p: ScoreRenderPart) => p.showChords && p.data.chords && p.data.chords.length > 0);
  const chordStrip: number = chordSource
    ? (chordSource.notation === "tab" ? DIAGRAM_HEIGHT + DIAGRAM_GAP : CHORD_NAME_GAP + fs)
    : 0;
  const showMeasureNumbers: boolean = parts.some((p: ScoreRenderPart) => p.showMeasureNumbers);

  const partHeights: number[] = parts.map((p: ScoreRenderPart) => blockHeight(p) + lyricsStrip(p));
  const stackHeight: number = partHeights.reduce((a: number, b: number) => a + b, 0) + PART_GAP * Math.max(0, parts.length - 1);
  const lineHeight: number = chordStrip + stackHeight + LINE_GAP;

  const measureCount: number = Math.max(...parts.map((p: ScoreRenderPart) => p.data.measures.length), 0);

  container.innerHTML = "";
  const div: HTMLDivElement = document.createElement("div");

  // ── Pass 0: build voices for every measure column & measure natural widths ──
  interface PartSlot {
    part: ScoreRenderPart;
    measure: RenderMeasure;
    voice: VF.Voice;
    tickables: VF.Tickable[];
  }
  const columns: PartSlot[][] = [];
  const natural: number[] = [];
  const baseWidth: number = opts.measureWidth || u(240);

  for (let i: number = 0; i < measureCount; i++) {
    const slots: PartSlot[] = [];
    for (const part of parts) {
      const m: RenderMeasure = part.data.measures[i];
      if (!m) {continue;}

      let tickables: VF.Tickable[];
      let tempStave: VF.Stave;
      if (part.notation === "staff") {
        tempStave = new VF.Stave(0, 0, baseWidth);
        tickables = m.staffNotes;
      } else if (part.notation === "tab") {
        tempStave = new VF.TabStave(0, 0, baseWidth, { spaceAboveStaffLn: 1, spaceBelowStaffLn: 1 });
        tickables = m.tabNotes;
      } else {
        tempStave = new VF.JianpuStave(0, 0, baseWidth, { digitFontSize: fs });
        tickables = m.notes;
      }
      for (const n of tickables) {n.setStave(tempStave);}

      const voice: VF.Voice = new VF.Voice({ numBeats: m.numBeats, beatValue: m.beatValue });
      voice.setStrict(false);
      voice.addTickables(tickables);
      slots.push({ part, measure: m, voice, tickables });
    }
    columns.push(slots);

    // Natural width = VexFlow's true minimum for this column's voices.
    const measurables: PartSlot[] = slots.filter((sl: PartSlot) => sl.tickables.length > 0);
    if (measurables.length > 0) {
      try {
        const probe: VF.Formatter = new VF.Formatter();
        probe.joinVoices(measurables.map((sl: PartSlot) => sl.voice));
        natural[i] = Math.max(probe.preCalculateMinTotalWidth(measurables.map((sl: PartSlot) => sl.voice)) + FORMATTER_PAD, MIN_COLUMN_W);
      } catch (e) {
        natural[i] = baseWidth;
      }
    } else {
      natural[i] = baseWidth;
    }
  }

  // ── Line breaking ──
  interface LineLayout { start: number, end: number, widths: number[], totalW: number }
  const lines: LineLayout[] = [];
  if (opts.perLine && opts.perLine > 0) {
    // Fixed: N per line, uniform width per line = max(base, widest natural).
    for (let start: number = 0; start < measureCount; start += opts.perLine) {
      const end: number = Math.min(start + opts.perLine, measureCount);
      let w: number = baseWidth;
      for (let i: number = start; i < end; i++) {w = Math.max(w, natural[i]);}
      lines.push({ start, end, widths: new Array(end - start).fill(w), totalW: w * (end - start) });
    }
  } else {
    // Dynamic: natural widths, greedy packing by available container width.
    const avail: number = (container.clientWidth > 0 ? container.clientWidth : baseWidth * 4) - SIDE_PADDING * 2;
    let start: number = 0;
    let curW: number = 0;
    let widths: number[] = [];
    for (let i: number = 0; i < measureCount; i++) {
      const w: number = natural[i];
      if (widths.length > 0 && curW + w > avail) {
        lines.push({ start, end: i, widths, totalW: curW });
        start = i;
        widths = [];
        curW = 0;
      }
      widths.push(w);
      curW += w;
    }
    if (widths.length > 0) {lines.push({ start, end: measureCount, widths, totalW: curW });}
  }

  const contentWidth: number = Math.max(...lines.map((l: LineLayout) => l.totalW), 0);
  const width: number = contentWidth + SIDE_PADDING * 2;
  const height: number = lines.length * lineHeight + TOP_PADDING + BOTTOM_PADDING;

  const renderer: VF.Renderer = new VF.Renderer(div, VF.RendererBackends.SVG);
  renderer.resize(width, height);
  const ctx: VF.RenderContext = renderer.getContext();

  // ── Draw pass ──
  for (let line: number = 0; line < lines.length; line++) {
    const { start, end, widths } = lines[line];
    const lineTop: number = TOP_PADDING + line * lineHeight;

    let x: number = SIDE_PADDING;
    for (let i: number = start; i < end; i++) {
      const colW: number = widths[i - start];
      const isFirstInLine: boolean = (i - start) === 0;
      const slots: PartSlot[] = columns[i];

      // Create real staves top-down in part order, re-point tickables.
      let yCursor: number = lineTop + chordStrip;
      const drawn: { slot: PartSlot, stave: VF.Stave, yBlock: number }[] = [];
      for (let pi: number = 0; pi < parts.length; pi++) {
        const part: ScoreRenderPart = parts[pi];
        const yBlock: number = yCursor;
        yCursor += partHeights[pi] + PART_GAP;
        const slot: PartSlot = slots.find((sl: PartSlot) => sl.part === part);
        if (!slot) {continue;}

        let stave: VF.Stave;
        if (part.notation === "staff") {
          stave = new VF.Stave(x, yBlock, colW, { leftBar: isFirstInLine });
        } else if (part.notation === "tab") {
          stave = new VF.TabStave(x, yBlock, colW, {
            leftBar: isFirstInLine, rightBar: true, spaceAboveStaffLn: 1, spaceBelowStaffLn: 1,
          });
        } else {
          stave = new VF.JianpuStave(x, yBlock, colW, { leftBar: isFirstInLine, digitFontSize: fs });
        }
        for (const n of slot.tickables) {n.setStave(stave);}
        drawn.push({ slot, stave, yBlock });
      }

      // Unified format: all parts' voices share tick contexts → aligned.
      const drawable: { slot: PartSlot, stave: VF.Stave, yBlock: number }[] =
        drawn.filter((d: { slot: PartSlot, stave: VF.Stave, yBlock: number }) => d.slot.tickables.length > 0);
      if (drawable.length > 0) {
        const formatter: VF.Formatter = new VF.Formatter();
        formatter.format(drawable.map((d: { slot: PartSlot, stave: VF.Stave, yBlock: number }) => d.slot.voice), colW - FORMATTER_PAD);
      }

      // Draw every part.
      for (const d of drawn) {
        const m: RenderMeasure = d.slot.measure;
        d.stave.setContext(ctx).draw();
        if (d.slot.tickables.length > 0) {d.slot.voice.setContext(ctx).draw();}
        if (d.slot.part.notation === "staff") {
          for (const b of m.staffBeams) { b.setContext(ctx).draw(); }
          for (const t of m.staffTuplets) { t.setContext(ctx).draw(); }
        } else if (d.slot.part.notation === "jianpu") {
          for (const b of m.beams) { b.setContext(ctx).draw(); }
          for (const t of m.tuplets) { t.setContext(ctx).draw(); }
          // Lyrics below this part's own digit baseline.
          if (m.lyrics.length > 0) {
            ctx.save();
            ctx.setFont({ family: "serif", size: LYRICS_FS, weight: "normal", style: "normal" });
            ctx.setFillStyle("black");
            for (const ly of m.lyrics) {
              if (ly.noteIndex < m.notes.length) {
                const jn: VF.JianpuNote = m.notes[ly.noteIndex];
                const nx: number = jn.getAbsoluteX() + jn.getDigitWidth() / 2;
                const ny: number = m.notes[0].getDigitBaselineY() + LYRICS_GAP;
                ctx.fillText(ly.text, nx - ctx.measureText(ly.text).width / 2, ny);
              }
            }
            ctx.restore();
          }
        }
      }

      // Measure number — above the top stave's barline (once per column).
      if (showMeasureNumbers && drawn.length > 0) {
        const barlineTopY: number = drawn[0].stave.getTopLineTopY();
        ctx.save();
        ctx.setFont({ family: "sans-serif", size: MEASURE_NUM_FS, weight: "normal", style: "normal" });
        ctx.setFillStyle("#999");
        const numText: string = measureLabel(drawn[0].slot.measure, i);
        const numW: number = ctx.measureText(numText).width;
        ctx.fillText(numText, x + u(2), barlineTopY - numW);
        ctx.restore();
      }

      // Chord symbol / diagram in the strip above the column.
      if (chordSource) {
        const chord: RenderChord = chordSource.data.chords.find((c: RenderChord) => c.measureIndex === i);
        if (chord) {
          if (chordSource.notation === "tab") {
            const positions: ChordPosition[] = getChordPositions(chord.chord);
            const diagramX: number = x + (colW - DIAGRAM_WIDTH) / 2;
            // AFTER staves, isolated group (SVGContext state safety).
            ctx.openGroup("chord-diagram", "chord-diag-score-" + i);
            drawChordDiagram(ctx, diagramX, lineTop, fs, positions, chord.chord);
            ctx.closeGroup();
          } else {
            ctx.save();
            ctx.setFont({ family: "sans-serif", size: fs, weight: "bold", style: "normal" });
            ctx.setFillStyle("black");
            const chordX: number = x + colW / 2;
            const chordY: number = lineTop + chordStrip - u(4);
            ctx.fillText(chord.chord, chordX - ctx.measureText(chord.chord).width / 2, chordY);
            ctx.restore();
          }
        }
      }

      x += colW;
    }
  }

  // Ties after everything is drawn (per part, per notation).
  for (const part of parts) {
    const partTies: VF.StaveTie[] = part.notation === "staff" ? (part.data.staffTies || []) : (part.data.ties || []);
    for (const tie of partTies) {
      try { tie.setContext(ctx).draw(); } catch (e) { console.warn("Tie draw error:", e); }
    }
  }

  container.appendChild(div);
}
