import assert from "node:assert/strict";
import { test } from "node:test";
import { composeSyllable, OutputComposer } from "../src/output.js";
import type { Language } from "../src/types.js";

function label(character: string): string {
  return `CHAR_${character.codePointAt(0)?.toString(16).toUpperCase()}`;
}

test("English remains compatible with the original 84-choice alphabet", () => {
  const composer = new OutputComposer("en");
  assert.equal(composer.options().length, 84);
  for (const character of "Hello, world!\n") composer.accept(label(character));
  assert.equal(composer.text, "Hello, world!\n");
  assert.deepEqual(composer.accept("EOS"), { emitted: "", done: true });
  assert.throws(() => composer.accept(label("a")), /already ended/);
});

test("Japanese includes voiced and small kana, long vowels, Latin, and punctuation", () => {
  const composer = new OutputComposer("ja");
  assert.equal(composer.options().length, 254);
  const text = "がっこう。キャット、コーヒー・API「はい」";
  for (const character of text) composer.accept(label(character));
  assert.equal(composer.text, text);
  for (const excluded of ["漢", "字", "ゐ", "ヷ"]) {
    assert.throws(() => composer.accept(label(excluded)), /not valid/);
  }
});

test("Korean commits a syllable only after its final consonant decision", () => {
  const composer = new OutputComposer("ko");
  assert.deepEqual(composer.accept("INITIAL_18"), { emitted: "", done: false });
  assert.equal(composer.stage, "medial");
  assert.equal(composer.options().length, 21);
  assert.throws(() => composer.accept("EOS"), /not valid/);
  composer.accept("MEDIAL_0");
  assert.equal(composer.stage, "final");
  assert.equal(composer.options().length, 28);
  assert.deepEqual(composer.pendingSyllable, { initial: "ㅎ", medial: "ㅏ" });
  assert.equal(composer.text, "");
  assert.throws(() => composer.accept(label(" ")), /not valid/);
  assert.deepEqual(composer.accept("FINAL_4"), { emitted: "한", done: false });
  assert.equal(composer.text, "한");
  assert.equal(composer.stage, "boundary");
});

test("Korean supports no batchim, tense initials, complex vowels, and compound finals", () => {
  const composer = new OutputComposer("ko");
  for (const [initial, medial, final] of [
    [0, 0, 0],
    [1, 9, 3],
    [0, 18, 0],
  ]) {
    composer.accept(`INITIAL_${initial}`);
    composer.accept(`MEDIAL_${medial}`);
    composer.accept(`FINAL_${final}`);
  }
  composer.accept(label(" "));
  composer.accept(label("1"));
  assert.equal(composer.text, "가꽋그 1");
});

test("the Unicode algorithm covers every modern Hangul syllable exactly once", () => {
  const syllables = new Set<string>();
  for (let initial = 0; initial < 19; initial++) {
    for (let medial = 0; medial < 21; medial++) {
      for (let final = 0; final < 28; final++) {
        const syllable = composeSyllable(initial, medial, final);
        const expectedJamo =
          String.fromCodePoint(0x1100 + initial, 0x1161 + medial) +
          (final === 0 ? "" : String.fromCodePoint(0x11a7 + final));
        assert.equal(syllable.normalize("NFD"), expectedJamo);
        syllables.add(syllable);
      }
    }
  }
  assert.equal(syllables.size, 11_172);
  assert.equal(composeSyllable(0, 0, 0), "가");
  assert.equal(composeSyllable(18, 20, 27), "힣");
  assert.equal(composeSyllable(0, 0, 3), "갃");
  for (const [initial, medial, final] of [
    [-1, 0, 0],
    [19, 0, 0],
    [0, 21, 0],
    [0, 0, 28],
    [0.5, 0, 0],
  ] as const) {
    assert.throws(
      () => composeSyllable(initial, medial, final),
      /Invalid Hangul/,
    );
  }
});

test("all output stages stay within the native Choice limit", () => {
  for (const language of ["en", "ja", "ko"] as Language[]) {
    const composer = new OutputComposer(language);
    assert.ok(composer.options().length <= 255);
    assert.equal(
      new Set(composer.options().map((option) => option.label)).size,
      composer.options().length,
    );
  }
});

test("invalid Korean transitions cannot mutate the committed prefix", () => {
  const composer = new OutputComposer("ko");
  composer.accept(label("A"));
  assert.throws(() => composer.accept("FINAL_1"), /not valid/);
  composer.accept("INITIAL_0");
  assert.throws(() => composer.accept("INITIAL_2"), /not valid/);
  assert.equal(composer.text, "A");
  assert.deepEqual(composer.pendingSyllable, { initial: "ㄱ", medial: null });
});
