/**
 * ScorePlayer data model.
 *
 * A ScorePlayer score is plain JSON (see demo/score-player.html for an
 * example). All UI-consumed settings live in this model: per-part audio
 * parameters (volume / pan / reverb) and display options (notation type,
 * measure numbers, chords), plus global tempo for playback speed control.
 *
 * Audio is a data model only — no audio engine is attached. Consumers can
 * subscribe to ScorePlayerOptions.onPlaybackStateChange to hook one in later.
 */

export type NotationType = "staff" | "jianpu" | "tab";

export interface ScoreData {
  title: string;
  authors: string[];
  global: GlobalSettings;
  parts: PartData[];
}

export interface GlobalSettings {
  timeSignature: { beats: number, beatType: number };
  keySignature: { fifths: number, mode: "major" | "minor" };
  bpm: number;
}

export interface PartData {
  id: string;
  name: string;
  notation: NotationType;
  instrument: {
    id: string;
    volume: number;   // 0..1
    pan: number;      // -1..1 (left..right)
    reverb: number;   // 0..1 wet mix
  };
  options: {
    showMeasureNumbers: boolean;
    showChords: boolean;
  };
  measures: MeasureData[];
}

export interface MeasureData {
  id: number;
  modifiers?: MeasureModifier[];
  notes: NoteData[];
}

export type MeasureModifier =
  | { type: "timeSignature", value: { beats: number, beatType: number } }
  | { type: "keySignature", value: { fifths: number, mode: "major" | "minor" } };

export interface NoteData {
  keys: KeyData[];            // >1 key = chord (staff/tab)
  duration: "w" | "h" | "q" | "8" | "16" | "32";
  dots?: number;              // 0|1|2 — appended to duration for VexFlow
  rest?: boolean;
  lyrics?: { verse: number, text: string }[];
  chord?: string;             // chord symbol starting at this note
  modifiers?: NoteModifier[];
}

export type NoteModifier =
  | { type: "tie_start" }
  | { type: "tie_stop" }
  | { type: "beam_start" }
  | { type: "beam_stop" }
  | { type: "tuplet_start", value: { actual: number, normal: number } }
  | { type: "tuplet_stop" };

export interface KeyData {
  pitch?: PitchData;          // required for staff/jianpu
  string?: number;            // tab: 1..6 (1 = high E)
  fret?: number;              // tab: 0 = open string
}

export interface PitchData {
  step: "C" | "D" | "E" | "F" | "G" | "A" | "B";
  octave: number;             // scientific pitch notation (C4 = middle C)
  alter?: number;             // semitone offset (-2..2), default 0
  accidental?: "sharp" | "flat" | "natural" | "doubleSharp" | "doubleFlat";
}

/** Playback control state — data model only, no audio engine. */
export interface PlaybackState {
  playing: boolean;
  bpm: number;
  speed: number;              // 0.5..2, default 1
  parts: PartPlaybackState[];
}

export interface PartPlaybackState {
  partId: string;
  volume: number;
  pan: number;
  reverb: number;
}
