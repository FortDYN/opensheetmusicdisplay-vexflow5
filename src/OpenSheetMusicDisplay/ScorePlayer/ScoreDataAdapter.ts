/**
 * ScoreDataAdapter — converts ScoreData (JSON model) into the RenderData
 * consumed by ScoreRenderEngine, one notation type per call.
 *
 * Pitch math mirrors the proven demo adapter (demo/osmd-dev.html):
 * scale degree = letter offset from the key's tonic; jianpu octave =
 * 4 + whole-octave difference from the tonic's half tone (C4 → 48).
 */

import * as VF from "vexflow";
import {
  GlobalSettings,
  KeyData,
  MeasureData,
  NotationType,
  NoteData,
  PartData,
} from "./ScoreData";
import { RenderData, RenderMeasure } from "./ScoreRenderEngine";

// Letter step → half-tone value of the natural note (C=0 … B=11).
const step2ne: { [step: string]: number } = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// Natural half-tone → letter index (C=0 … B=6), and back.
const ne2letter: { [ne: number]: number } = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
const letter2ne: number[] = [0, 2, 4, 5, 7, 9, 11];
const acc2vf: { [acc: string]: string } = {
  sharp: "#", flat: "b", natural: "n", doubleSharp: "##", doubleFlat: "bb",
};
const durationBeats: { [dur: string]: number } = {
  w: 4, h: 2, q: 1, "8": 0.5, "16": 0.25, "32": 0.125,
};

/** Tonic letter index (0=C … 6=B) from a key signature. */
function tonicLetterIndex(fifths: number, mode: "major" | "minor"): number {
  const base: number = mode === "minor" ? 5 : 0; // A for minor, C for major
  return fifths >= 0 ? (base + fifths * 4) % 7 : (base + Math.abs(fifths) * 3) % 7;
}

/** Note length in whole-note units, dots included. */
function wholeUnits(note: NoteData): number {
  const base: number = durationBeats[note.duration] / 4; // durationBeats is in quarter units
  const dotMul: number = note.dots === 2 ? 1.75 : note.dots === 1 ? 1.5 : 1;
  return base * dotMul;
}

/** VexFlow duration string with dot suffixes, e.g. "q" + 1 dot → "qd". */
function vfDuration(note: NoteData): string {
  let dur: string = note.duration;
  for (let d: number = 0; d < (note.dots || 0); d++) {dur += "d";}
  return dur;
}

interface KeyContext {
  tonicLetter: number;
  tonicHT: number;
}

function keyContext(fifths: number, mode: "major" | "minor"): KeyContext {
  const tonicLetter: number = tonicLetterIndex(fifths, mode);
  return { tonicLetter, tonicHT: letter2ne[tonicLetter] + 48 };
}

/** Per-measure time signature (falls back to global). */
function measureTime(m: MeasureData, global: GlobalSettings): { beats: number, beatType: number } {
  if (m.modifiers) {
    for (const mod of m.modifiers) {
      if (mod.type === "timeSignature") {return mod.value;}
    }
  }
  return global.timeSignature;
}

/** Per-measure key signature (falls back to global / previous — caller threads it). */
function measureKey(m: MeasureData, fallback: KeyContext): KeyContext {
  if (m.modifiers) {
    for (const mod of m.modifiers) {
      if (mod.type === "keySignature") {return keyContext(mod.value.fifths, mod.value.mode);}
    }
  }
  return fallback;
}

/**
 * Convert one part into RenderData for the requested notation.
 * `fs` is the digit font size (drives JianpuNote glyph metrics).
 */
export function partToRenderData(
  part: PartData,
  global: GlobalSettings,
  notation: NotationType,
  fs: number
): RenderData {
  const measures: RenderMeasure[] = [];
  const ties: VF.StaveTie[] = [];
  const staffTies: VF.StaveTie[] = [];
  const chords: { measureIndex: number, chord: string }[] = [];

  let keyCtx: KeyContext = keyContext(global.keySignature.fifths, global.keySignature.mode);

  // Cross-measure modifier state (per part).
  let tieStartJianpu: VF.JianpuNote = null;
  let tieStartStaff: VF.StaveNote = null;

  for (let mi: number = 0; mi < part.measures.length; mi++) {
    const md: MeasureData = part.measures[mi];
    keyCtx = measureKey(md, keyCtx);
    const ts: { beats: number, beatType: number } = measureTime(md, global);

    const rm: RenderMeasure = {
      numBeats: ts.beats,
      beatValue: ts.beatType,
      measureNumber: md.id,
      notes: [],
      beams: [],
      tuplets: [],
      lyrics: [],
      staffNotes: [],
      staffBeams: [],
      staffTuplets: [],
      tabNotes: [],
    };

    // Beam / tuplet collection state (per measure).
    let beamGroupJ: VF.JianpuNote[] = null;
    let beamGroupS: VF.StaveNote[] = null;
    let tupletGroupJ: VF.JianpuNote[] = null;
    let tupletGroupS: VF.StaveNote[] = null;
    let tupletValue: { actual: number, normal: number } = null;

    const flushBeam: () => void = (): void => {
      if (beamGroupJ && beamGroupJ.length >= 2) {rm.beams.push(new VF.JianpuBeam(beamGroupJ));}
      if (beamGroupS && beamGroupS.length >= 2) {rm.staffBeams.push(new VF.Beam(beamGroupS));}
      beamGroupJ = null;
      beamGroupS = null;
    };
    const flushTuplet: () => void = (): void => {
      if (tupletValue) {
        if (tupletGroupJ && tupletGroupJ.length >= 2) {
          rm.tuplets.push(new VF.Tuplet(tupletGroupJ, {
            numNotes: tupletValue.actual, notesOccupied: tupletValue.normal, bracketed: true,
          }));
        }
        if (tupletGroupS && tupletGroupS.length >= 2) {
          rm.staffTuplets.push(new VF.Tuplet(tupletGroupS, {
            numNotes: tupletValue.actual, notesOccupied: tupletValue.normal,
          }));
        }
      }
      tupletGroupJ = null;
      tupletGroupS = null;
      tupletValue = null;
    };

    for (const nd of md.notes) {
      const beats: number = wholeUnits(nd) * ts.beatType; // beats in this measure's beat unit
      const isLong: boolean = beats >= 2;
      const mods: { type: string, value?: any }[] = nd.modifiers || [];
      const has: (t: string) => boolean = (t: string): boolean => mods.some((mo: { type: string, value?: any }) => mo.type === t);
      const modVal: (t: string) => any = (t: string): any => {
        const mo: { type: string, value?: any } = mods.find((m2: { type: string, value?: any }) => m2.type === t);
        return mo ? (mo as any).value : undefined;
      };

      // ── Jianpu ──
      if (notation === "jianpu") {
        const pitch: { step: string, octave: number, alter?: number, accidental?: string } = nd.keys[0] && nd.keys[0].pitch;
        let scaleDegree: number = 0;
        let octave: number = 4;
        if (!nd.rest && pitch) {
          const ne: number = step2ne[pitch.step];
          const alter: number = pitch.alter || 0;
          scaleDegree = ((ne2letter[ne] - keyCtx.tonicLetter + 7) % 7) + 1;
          const noteHT: number = ne + alter + pitch.octave * 12;
          octave = 4 + Math.trunc((noteHT - keyCtx.tonicHT) / 12);
        }

        const jn: VF.JianpuNote = new VF.JianpuNote({
          scaleDegree: nd.rest ? 0 : scaleDegree,
          octave,
          duration: isLong ? "q" : vfDuration(nd),
          dash: false,
          digitFontSize: fs,
        });
        if (!nd.rest && pitch && pitch.accidental) {
          const acc: string = acc2vf[pitch.accidental];
          if (acc) {jn.addModifier(new VF.Accidental(acc), 0);}
        }
        if (!isLong) {
          for (let d: number = 0; d < (nd.dots || 0); d++) {jn.addModifier(new VF.Dot(), 0);}
        }
        rm.notes.push(jn);

        // Lyrics (verse 1)
        if (nd.lyrics && nd.lyrics.length > 0) {
          const ly: { text: string, verse: number } = nd.lyrics.find((l: { text: string, verse: number }) => l.verse === 1) || nd.lyrics[0];
          rm.lyrics.push({ text: ly.text, noteIndex: rm.notes.length - 1 });
        }

        // Extension dashes for half/whole notes
        if (isLong) {
          const dashCount: number = Math.round(beats) - 1;
          for (let d: number = 0; d < dashCount; d++) {
            rm.notes.push(new VF.JianpuNote({
              scaleDegree: jn.scaleDegree, octave, duration: "q", dash: true, digitFontSize: fs,
            }));
          }
        }

        // Modifiers
        if (has("beam_start")) {beamGroupJ = [jn];}
        else if (beamGroupJ) {beamGroupJ.push(jn);}
        if (has("beam_stop")) {flushBeam();}
        if (has("tuplet_start")) { tupletValue = modVal("tuplet_start"); tupletGroupJ = [jn]; }
        else if (tupletGroupJ) {tupletGroupJ.push(jn);}
        if (has("tuplet_stop")) {flushTuplet();}
        if (has("tie_start")) {tieStartJianpu = jn;}
        if (has("tie_stop") && tieStartJianpu) {
          ties.push(new VF.StaveTie({ firstNote: tieStartJianpu, lastNote: jn }));
          tieStartJianpu = null;
        }
      }

      // ── Staff ──
      if (notation === "staff") {
        const dur: string = vfDuration(nd);
        let sn: VF.StaveNote;
        if (nd.rest) {
          sn = new VF.StaveNote({ keys: ["d/5"], duration: dur + "r", autoStem: true });
        } else {
          const keys: string[] = nd.keys
            .filter((k: KeyData) => !!k.pitch)
            .map((k: KeyData) => k.pitch.step.toLowerCase() + "/" + k.pitch.octave);
          sn = new VF.StaveNote({ keys, duration: dur, autoStem: true });
          nd.keys.forEach((k: KeyData, ki: number) => {
            if (k.pitch && k.pitch.accidental) {
              const acc: string = acc2vf[k.pitch.accidental];
              if (acc) {sn.addModifier(new VF.Accidental(acc), ki);}
            }
          });
        }
        for (let d: number = 0; d < (nd.dots || 0); d++) {sn.addModifier(new VF.Dot(), 0);}
        rm.staffNotes.push(sn);

        if (has("beam_start")) {beamGroupS = [sn];}
        else if (beamGroupS) {beamGroupS.push(sn);}
        if (has("beam_stop")) {flushBeam();}
        if (has("tuplet_start")) { tupletValue = modVal("tuplet_start"); tupletGroupS = [sn]; }
        else if (tupletGroupS) {tupletGroupS.push(sn);}
        if (has("tuplet_stop")) {flushTuplet();}
        if (has("tie_start")) {tieStartStaff = sn;}
        if (has("tie_stop") && tieStartStaff) {
          staffTies.push(new VF.StaveTie({ firstNote: tieStartStaff, lastNote: sn }));
          tieStartStaff = null;
        }
      }

      // ── Tab ──
      if (notation === "tab") {
        const positions: { str: string, fret: number }[] = nd.keys
          .filter((k: KeyData) => k.string != null && k.fret != null)
          .map((k: KeyData) => ({ str: k.string, fret: k.fret }));
        // Skip notes without string/fret data (blank space = rest on the tab
        // staff) so switching a pitch-only part to tab never crashes.
        if (positions.length > 0) {
          const tn: VF.TabNote = new VF.TabNote({ positions, duration: vfDuration(nd) }, false);
          rm.tabNotes.push(tn);
        }
      }

      // First chord symbol in a measure wins
      if (nd.chord && !chords.some(c => c.measureIndex === mi)) {
        chords.push({ measureIndex: mi, chord: nd.chord });
      }
    }

    flushBeam();
    flushTuplet();
    measures.push(rm);
  }

  return { measures, ties, staffTies, chords };
}
