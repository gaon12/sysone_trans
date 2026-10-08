import type { ChoiceOption, Language } from "./types.js";

export const INITIALS = Array.from("ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ");
export const MEDIALS = Array.from("ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ");
export const FINALS = [
  "",
  ...Array.from("ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"),
];

export type OutputStage = "boundary" | "medial" | "final";

type OutputOption = ChoiceOption &
  (
    | { kind: "character"; character: string }
    | { kind: "initial" | "medial" | "final"; index: number }
    | { kind: "eos" }
  );

const ASCII_CHARACTERS = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,?!'\"-:;()/&%+$@#_\n",
);
const JAPANESE_PUNCTUATION = Array.from("。、「」・ー");
const EOS: OutputOption = {
  label: "EOS",
  kind: "eos",
  description: "The translation is complete; no more characters are needed.",
};

function unicodeRange(start: number, end: number): string[] {
  return Array.from({ length: end - start + 1 }, (_, index) =>
    String.fromCodePoint(start + index),
  );
}

function characterOption(character: string): OutputOption {
  const display =
    character === " "
      ? "a single space"
      : character === "\n"
        ? "a newline"
        : JSON.stringify(character);
  return {
    label: `CHAR_${character.codePointAt(0)?.toString(16).toUpperCase()}`,
    kind: "character",
    character,
    description: `Append ${display} as the next output character.`,
  };
}

function jamoOptions(
  kind: "initial" | "medial" | "final",
  letters: readonly string[],
): OutputOption[] {
  return letters.map((letter, index) => ({
    label: `${kind.toUpperCase()}_${index}`,
    kind,
    index,
    description: letter
      ? `The ${kind} of the current Hangul syllable is ${JSON.stringify(letter)}.`
      : "The current Hangul syllable has no final consonant (no batchim).",
  }));
}

/** Compose modern Hangul using the Unicode L/V/T syllable algorithm. */
export function composeSyllable(
  initial: number,
  medial: number,
  final: number,
): string {
  for (const [name, index, limit] of [
    ["initial", initial, 19],
    ["medial", medial, 21],
    ["final", final, 28],
  ] as const) {
    if (!Number.isInteger(index) || index < 0 || index >= limit) {
      throw new Error(`Invalid Hangul ${name} index.`);
    }
  }
  return String.fromCodePoint(0xac00 + (initial * 21 + medial) * 28 + final);
}

function boundaryOptions(language: Language): OutputOption[] {
  const characters = [...ASCII_CHARACTERS];
  if (language === "ja") {
    // Omit rare/archaic kana to keep Latin, modern kana, and punctuation below 255.
    const omitted = new Set(Array.from("ゐゑゕゖヰヱヵヶヷヸヹヺ"));
    characters.push(
      ...unicodeRange(0x3041, 0x3096).filter((letter) => !omitted.has(letter)),
      ...unicodeRange(0x30a1, 0x30fa).filter((letter) => !omitted.has(letter)),
      ...JAPANESE_PUNCTUATION,
    );
  }
  const options = [...new Set(characters)].map(characterOption);
  if (language === "ko") options.push(...jamoOptions("initial", INITIALS));
  options.push(EOS);
  if (options.length > 255)
    throw new Error("Output alphabet exceeds 255 choices.");
  return options;
}

/** Keep committed text immutable and expose only legal next output choices. */
export class OutputComposer {
  private committed = "";
  private initial: number | null = null;
  private medial: number | null = null;
  private finished = false;
  private readonly boundaries: OutputOption[];

  constructor(readonly language: Language) {
    this.boundaries = boundaryOptions(language);
  }

  get text(): string {
    return this.committed;
  }

  get stage(): OutputStage {
    return this.initial === null
      ? "boundary"
      : this.medial === null
        ? "medial"
        : "final";
  }

  get pendingSyllable(): { initial: string | null; medial: string | null } {
    return {
      initial: this.initial === null ? null : (INITIALS[this.initial] ?? null),
      medial: this.medial === null ? null : (MEDIALS[this.medial] ?? null),
    };
  }

  private availableOptions(): OutputOption[] {
    if (this.finished) throw new Error("Output has already ended.");
    if (this.stage === "medial") return jamoOptions("medial", MEDIALS);
    if (this.stage === "final") return jamoOptions("final", FINALS);
    return this.boundaries;
  }

  options(): ChoiceOption[] {
    return this.availableOptions().map(({ label, description }) => ({
      label,
      description,
    }));
  }

  accept(label: string): { emitted: string; done: boolean } {
    const option = this.availableOptions().find(
      (candidate) => candidate.label === label,
    );
    if (!option)
      throw new Error("The chosen output unit is not valid at this stage.");
    let emitted = "";
    switch (option.kind) {
      case "eos":
        this.finished = true;
        return { emitted, done: true };
      case "character":
        emitted = option.character;
        break;
      case "initial":
        this.initial = option.index;
        break;
      case "medial":
        this.medial = option.index;
        break;
      case "final":
        if (this.initial === null || this.medial === null)
          throw new Error("Incomplete Hangul syllable.");
        emitted = composeSyllable(this.initial, this.medial, option.index);
        this.initial = null;
        this.medial = null;
        break;
    }
    this.committed += emitted;
    return { emitted, done: false };
  }
}
