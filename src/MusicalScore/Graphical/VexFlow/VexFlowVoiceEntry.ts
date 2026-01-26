import Vex from "vexflow";
import VF = Vex.Flow;
import { VoiceEntry } from "../../VoiceData/VoiceEntry";
import { GraphicalVoiceEntry } from "../GraphicalVoiceEntry";
import { GraphicalStaffEntry } from "../GraphicalStaffEntry";
import { unitInPixels } from "./VexFlowMusicSheetDrawer";
import { NoteEnum } from "../../../Common/DataObjects/Pitch";
import { Note } from "../../VoiceData/Note";
import { ColoringModes } from "../../../Common/Enums/ColoringModes";
import { GraphicalNote } from "../GraphicalNote";
import { EngravingRules } from "../EngravingRules";
import { NoteHeadShape } from "../../VoiceData/Notehead";

/** Helper function to invert brightness while preserving hue for contrast preservation */
function invertColorForContrast(colorHex: string): string {
    if (!colorHex || colorHex === "#000000" || colorHex === "#FFFFFF") {
        return colorHex; // Don't invert pure black or white
    }

    // Handle transparent colors
    if (colorHex.length === 9 && colorHex.startsWith("#")) {
        const rgb: string = colorHex.substring(1, 7);
        const alpha: string = colorHex.substring(7, 9);
        const inverted: string = invertBrightnessRgbHex(rgb);
        return "#" + inverted + alpha;
    } else if (colorHex.length === 7 && colorHex.startsWith("#")) {
        const rgb: string = colorHex.substring(1);
        return "#" + invertBrightnessRgbHex(rgb);
    }

    return colorHex;
}

function invertBrightnessRgbHex(rgbHex: string): string {
    // Parse RGB
    const r: number = parseInt(rgbHex.substring(0, 2), 16) / 255;
    const g: number = parseInt(rgbHex.substring(2, 4), 16) / 255;
    const b: number = parseInt(rgbHex.substring(4, 6), 16) / 255;

    // Convert RGB to HSL
    const max: number = Math.max(r, g, b);
    const min: number = Math.min(r, g, b);
    const l: number = (max + min) / 2;
    let h: number = 0;
    let s: number = 0;

    if (max !== min) {
        const d: number = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

        if (max === r) {
            h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        } else if (max === g) {
            h = ((b - r) / d + 2) / 6;
        } else {
            h = ((r - g) / d + 4) / 6;
        }
    }

    // Invert lightness only
    const lInverted: number = 1 - l;

    // Convert HSL back to RGB
    const hslToRgb: (hIn: number, sIn: number, lIn: number) => [number, number, number] = (hIn, sIn, lIn) => {
        let rOut: number;
        let gOut: number;
        let bOut: number;

        if (sIn === 0) {
            rOut = gOut = bOut = lIn;
        } else {
            const hue2rgb: (pHue: number, qHue: number, t: number) => number = (pHue, qHue, t) => {
                if (t < 0) { t += 1; }
                if (t > 1) { t -= 1; }
                if (t < 1 / 6) { return pHue + (qHue - pHue) * 6 * t; }
                if (t < 1 / 2) { return qHue; }
                if (t < 2 / 3) { return pHue + (qHue - pHue) * (2 / 3 - t) * 6; }
                return pHue;
            };

            const q: number = lIn < 0.5 ? lIn * (1 + sIn) : lIn + sIn - lIn * sIn;
            const p: number = 2 * lIn - q;
            rOut = hue2rgb(p, q, hIn + 1 / 3);
            gOut = hue2rgb(p, q, hIn);
            bOut = hue2rgb(p, q, hIn - 1 / 3);
        }

        return [rOut, gOut, bOut];
    };

    const [rNew, gNew, bNew]: [number, number, number] = hslToRgb(h, s, lInverted);

    // Convert back to hex
    const toHex: (n: number) => string = (n) => {
        const hex: string = Math.round(n * 255).toString(16);
        return hex.padStart(2, "0");
    };

    return toHex(rNew) + toHex(gNew) + toHex(bNew);
}

export class VexFlowVoiceEntry extends GraphicalVoiceEntry {
    private mVexFlowStaveNote: VF.StemmableNote;
    public vfGhostNotes: VF.GhostNote[]; // sometimes we need multiple ghost notes instead of just one note (vfStaveNote).

    constructor(parentVoiceEntry: VoiceEntry, parentStaffEntry: GraphicalStaffEntry, rules?: EngravingRules) {
        super(parentVoiceEntry, parentStaffEntry, rules);
    }

    public applyBordersFromVexflow(): void {
        const staveNote: any = (this.vfStaveNote as any);
        if (!staveNote.getNoteHeadBeginX) {
            return;
        }
        const boundingBox: any = staveNote.getBoundingBox();
        const modifierWidth: number = staveNote.getNoteHeadBeginX() - boundingBox.x;

        this.PositionAndShape.RelativePosition.y = boundingBox.y / unitInPixels;
        this.PositionAndShape.BorderTop = 0;
        this.PositionAndShape.BorderBottom = boundingBox.h / unitInPixels;
        const halfStavenoteWidth: number = (staveNote.width - ((staveNote as any).paddingRight ?? 0)) / 2;
        this.PositionAndShape.BorderLeft = -(modifierWidth + halfStavenoteWidth) / unitInPixels; // Left of our X origin is the modifier
        this.PositionAndShape.BorderRight = (boundingBox.w - modifierWidth) / unitInPixels; // Right of x origin is the note
    }

    public set vfStaveNote(value: VF.StemmableNote) {
        this.mVexFlowStaveNote = value;
    }

    public get vfStaveNote(): VF.StemmableNote {
        return this.mVexFlowStaveNote;
    }

    /** Apply custom noteheads from Note.CustomNoteheadVFCode. This should happen before color(). */
    public applyCustomNoteheads(): void {
        const vfStaveNote: any = (<VexFlowVoiceEntry>(this as any)).vfStaveNote;
        if (!vfStaveNote) {
            return;
        }
        for (let i: number = 0; i < this.notes.length; i++) {
            const note: Note = this.notes[i].sourceNote;
            if (vfStaveNote.note_heads) { // see VexFlowConverter, needs Vexflow PR
                if (note.CustomNoteheadVFCode) {
                    (vfStaveNote.note_heads[i] as any).glyph_code = note.CustomNoteheadVFCode;
                }
            }
        }
    }

    /** (Re-)color notes and stems by setting their Vexflow styles.
     * Could be made redundant by a Vexflow PR, but Vexflow needs more solid and permanent color methods/variables for that
     * See VexFlowConverter.StaveNote()
     */
    public color(): void {
        const defaultColorNotehead: string = this.rules.DefaultColorNotehead;
        const defaultColorRest: string = this.rules.DefaultColorRest;
        const defaultColorStem: string = this.rules.DefaultColorStem;
        const transparentColor: string = "#00000000"; // transparent color in vexflow
        let noteheadColor: string; // if null: no noteheadcolor to set (stays black)
        let sourceNoteNoteheadColor: string;

        const vfStaveNote: any = (<VexFlowVoiceEntry>(this as any)).vfStaveNote;
        for (let i: number = 0; i < this.notes.length; i++) {
            const note: GraphicalNote = this.notes[i];

            sourceNoteNoteheadColor = note.sourceNote.NoteheadColor;
            noteheadColor = sourceNoteNoteheadColor;
            // Switch between XML colors and automatic coloring
            if (this.rules.ColoringMode === ColoringModes.AutoColoring ||
                this.rules.ColoringMode === ColoringModes.CustomColorSet) {
                if (note.sourceNote.isRest()) {
                    noteheadColor = this.rules.ColoringSetCurrent.getValue(-1);
                } else {
                    const fundamentalNote: NoteEnum = note.sourceNote.Pitch.FundamentalNote;
                    noteheadColor = this.rules.ColoringSetCurrent.getValue(fundamentalNote);
                }
            }
            if (!note.sourceNote.PrintObject || (note.sourceNote.Notehead?.Shape === NoteHeadShape.NONE)) {
                noteheadColor = transparentColor; // transparent (for PrintObject=false or notehead="none")
            } else if (!noteheadColor // revert transparency after PrintObject was set to false, then true again
                || noteheadColor === "#000000" // questionable, because you might want to set specific notes to black,
                                               // but unfortunately some programs export everything explicitly as black
                ) {
                noteheadColor = this.rules.DefaultColorNotehead;
            }

            // DEBUG runtime coloring test
            /*const testColor: string = "#FF0000";
            if (i === 2 && Math.random() < 0.1 && note.sourceNote.NoteheadColor !== testColor) {
                const measureNumber: number = note.parentVoiceEntry.parentStaffEntry.parentMeasure.MeasureNumber;
                noteheadColor = testColor;
                console.log("color changed to " + noteheadColor + " of this note:\n" + note.sourceNote.Pitch.ToString() +
                    ", in measure #" + measureNumber);
            }*/

            if (!sourceNoteNoteheadColor && this.rules.ColoringMode === ColoringModes.XML &&
                note.sourceNote.PrintObject && note.sourceNote.Notehead?.Shape !== NoteHeadShape.NONE) {
                if (!note.sourceNote.isRest() && defaultColorNotehead) {
                    noteheadColor = defaultColorNotehead;
                } else if (note.sourceNote.isRest() && defaultColorRest) {
                    noteheadColor = defaultColorRest;
                }
            }
            if (noteheadColor && note.sourceNote.PrintObject  && note.sourceNote.Notehead?.Shape !== NoteHeadShape.NONE) {
                // Apply brightness inversion for contrast if enabled
                if (this.rules.InvertBrightnessForContrast && this.rules.DarkModeEnabled) {
                    noteheadColor = invertColorForContrast(noteheadColor);
                }
                note.sourceNote.NoteheadColorCurrentlyRendered = noteheadColor;
            } else if (!noteheadColor) {
                continue;
            }

            // color notebeam if all noteheads have same color and stem coloring enabled
            if (this.rules.ColoringEnabled && note.sourceNote.NoteBeam && this.rules.ColorBeams) {
                const beamNotes: Note[] = note.sourceNote.NoteBeam.Notes;
                let colorBeam: boolean = true;
                for (let j: number = 0; j < beamNotes.length; j++) {
                    if (beamNotes[j].NoteheadColorCurrentlyRendered !== noteheadColor) {
                        colorBeam = false;
                    }
                }
                if (colorBeam) {
                    if (vfStaveNote?.beam?.setStyle) {
                        vfStaveNote.beam.setStyle({ fillStyle: noteheadColor, strokeStyle: noteheadColor});
                    }
                }
            }

            if (vfStaveNote) {
                if (vfStaveNote.note_heads) { // see VexFlowConverter, needs Vexflow PR
                    const notehead: any = vfStaveNote.note_heads[i];
                    if (notehead) {
                        notehead.setStyle({ fillStyle: noteheadColor, strokeStyle: noteheadColor });
                    }
                }
                // set ledger line color. TODO coordinate this with VexFlowConverter.StaveNote(), where there's also still code for this, maybe unnecessarily.
                if ((vfStaveNote as any).setLedgerLineStyle) { // setLedgerLineStyle doesn't exist on TabNote or rest, would throw error.
                    if (noteheadColor === transparentColor) {
                        (vfStaveNote as any).setLedgerLineStyle(
                            { fillStyle: noteheadColor, strokeStyle: noteheadColor, lineWidth: this.rules.LedgerLineWidth });
                    } else {
                        (vfStaveNote as any).setLedgerLineStyle({
                            fillStyle: this.rules.LedgerLineColorDefault,
                            lineWidth: this.rules.LedgerLineWidth,
                            strokeStyle: this.rules.LedgerLineColorDefault
                        });
                        // we could give the color (style) as noteheadColor, but then we need to figure out which note has the ledger line.
                        // otherwise ledger lines get the color of the top note, see Function Test Color.
                    }
                }
            }
        }

        // color stems
        let stemColor: string = defaultColorStem; // reset to black/default when coloring was disabled. maybe needed elsewhere too
        let setVoiceEntryStemColor: boolean = false;
        if (this.rules.ColoringEnabled) {
            stemColor = this.parentVoiceEntry.StemColor; // TODO: once coloringSetCustom gets stem color, respect it
            if (!stemColor
                || stemColor === "#000000") { // see above, noteheadColor === "#000000"
                stemColor = defaultColorStem;
            }
            if (this.rules.ColorStemsLikeNoteheads && noteheadColor) {
                // condition could be even more fine-grained by only recoloring if there was no custom StemColor set. will be more complex though
                stemColor = noteheadColor;
                setVoiceEntryStemColor = true;
            }
        }
        let stemTransparent: boolean = true;
        for (const note of this.parentVoiceEntry.Notes) {
            if (note.PrintObject && note.Notehead?.Shape !== NoteHeadShape.NONE) {
                stemTransparent = false;
                break;
            }
        }
        if (stemTransparent) {
            stemColor = transparentColor;
        }
        // Apply brightness inversion for stem contrast if enabled
        // But skip if ColorStemsLikeNoteheads is true, since stemColor brightness is already inverted (it came from noteheadColor)
        const stemBrightnessAlreadyInverted: boolean =
            this.rules.ColorStemsLikeNoteheads && !!noteheadColor;
        if (this.rules.InvertBrightnessForContrast
            && this.rules.DarkModeEnabled
            && stemColor
            && stemColor !== transparentColor
            && !stemBrightnessAlreadyInverted) {
            stemColor = invertColorForContrast(stemColor);
        }
        const stemStyle: Object = { fillStyle: stemColor, strokeStyle: stemColor };

        if (vfStaveNote && vfStaveNote.setStemStyle) {
            if (!stemTransparent && setVoiceEntryStemColor) {
                this.parentVoiceEntry.StemColor = stemColor; // this shouldn't be set by DefaultColorStem
            }
            vfStaveNote.setStemStyle(stemStyle);
            if (vfStaveNote.flag && vfStaveNote.setFlagStyle && this.rules.ColorFlags) {
                vfStaveNote.setFlagStyle(stemStyle);
            }
        }
    }
}
