# System One Translator

Licensed under the [MIT License](LICENSE).

An experiment that builds translations by repeatedly asking a native decision
model to select the next output unit from a fixed set of choices.

The primary implementation is a TypeScript CLI using Vercel AI SDK's
`experimental_decide`. It calls TypeSafe Jev and OpenAI Decisions directly with
your own provider keys. The original `run.py` remains an English-only Python
reference.

## Setup

Use Node.js 24 or newer. Install the exact dependency versions from the lockfile:

```sh
npm ci
```

Copy `.env.example` to `.env` and fill in the keys for the providers you want to
use. In PowerShell:

```powershell
Copy-Item .env.example .env
```

```dotenv
TYPESAFE_API_KEY=your-typesafe-key
OPENAI_API_KEY=your-openai-key
```

Only selected providers need credentials. `TYPESAFE_AI_API_KEY` is also accepted
when `TYPESAFE_API_KEY` is absent. The CLI reads `.env` from the project root;
existing process environment variables take precedence. Keys remain in the local
process and are sent only to their provider's native API. They are excluded from
logs and result reports. `.env` and `results/` are ignored by Git.

## Translate

Korean to English with Jev:

```sh
npm run translate -- --model typesafe:jev-latest --from ko --to en "나는 사과를 좋아한다."
```

English to Korean with OpenAI Decisions:

```sh
npm run translate -- --model openai:gpt-6-luna --from en --to ko "I like apples."
```

English to Japanese kana:

```sh
npm run translate -- --to ja --from en --show-probabilities "I like coffee."
```

The default model is `typesafe:jev-latest`, the default source language is `auto`,
and the default target is `en`. Source text may also be piped to the command or
entered at the interactive prompt. Quote text containing spaces as one argument.
Use `--` before positional text that starts with a hyphen.

Model IDs use `typesafe:<model>` or `openai:<model>`. Other Jev model IDs can be
passed through the same provider. OpenAI's documented native Decisions model is
currently `gpt-6-luna`; passing a general chat model does not enable Decisions.
There is no automatic provider or model fallback.

## Compare models

Run the same source through both default providers, all three output languages,
and two repetitions:

```sh
npm run compare -- --to en,ja,ko --repeat 2 --max-chars 120 --json results/comparison.json "나는 사과를 좋아한다."
```

Select explicit models or compare different versions from one provider:

```sh
npm run compare -- --models typesafe:jev-latest,openai:gpt-6-luna --to en --repeat 3 "안녕하세요."
```

All selected providers are configured before any API request. Runs proceed
sequentially; model order rotates between repetitions. A provider request failure
is recorded for that run, and remaining runs continue. A missing key or invalid
setting stops the entire experiment during preflight.

Each run records output, completion status, decision count, elapsed time, and
reported token usage. Summaries show completion rate and average duration,
decisions, and output characters **over completed runs only**. Speed is not a
translation-quality score. Review accuracy, fluency, and meaning separately.

`--json` saves settings, pinned dependency versions, requested and resolved model
IDs, every successful decision's full distribution, provider confidence, emitted
text, partial prefixes, and pending Hangul components. The report also records
whether the experiment was interrupted. Existing report files are not overwritten;
choose a different path for another experiment.

## Output alphabets

| Target          | Output unit                                         | Choice count  |
| --------------- | --------------------------------------------------- | ------------- |
| English (`en`)  | One character                                       | 84            |
| Japanese (`ja`) | One kana or literal character                       | 254           |
| Korean (`ko`)   | Initial, medial, then final; literals at boundaries | 103 / 21 / 28 |

Every alphabet also allows Latin letters, digits, spaces, and common ASCII
punctuation. English has the original experiment's alphabet. Japanese adds modern
hiragana, katakana, Japanese punctuation, and the long-vowel mark; it does not
emit kanji. Rare or archaic `ゐゑゕゖヰヱヵヶヷヸヹヺ`, half-width kana, and iteration
marks are omitted to keep the complete set below 255 choices. Input Japanese text
can still contain kanji.

Korean selects an initial from 19 possibilities, a medial from 21, and a final
from 28, including no batchim. Compound vowels and final consonants are individual
choices. The Unicode composition algorithm then commits one complete syllable.
This covers all 11,172 modern Hangul syllables without a Python library. Spaces,
punctuation, Latin text, and EOS are allowed only between complete syllables.
Old Hangul, standalone jamo, and emoji are outside the output alphabets.

The complete source, immutable committed prefix, current stage, and pending Hangul
components are supplied for every decision. Earlier output cannot be revised.

## Limits, cancellation, and measurements

```sh
npm run translate -- --max-chars 100 --max-decisions 301 --timeout-ms 30000 --retries 2 --json results/one-run.json "안녕하세요."
```

- `--max-chars` caps committed output characters; default: 500.
- `--max-decisions` caps application decision attempts. By default it allows one
  attempt per English/Japanese character or three per Korean syllable, plus EOS.
- At the character cap, one more decision may select EOS. If it chooses another
  unit, that unit is recorded but not appended, and status is `max_chars`.
- `--timeout-ms` bounds each decision, including its retry waits; default: 30000.
- `--retries` controls SDK retries for temporary errors; default: 2. Retries can
  produce more HTTP requests than the application decision count.
- Ctrl+C cancels the current request, stops further runs, and retains partial
  results in the requested JSON report. A second Ctrl+C can terminate immediately.
- Exit codes: `0` means every run completed; `1` means an error or incomplete
  output; `130` means cancellation.

Result statuses are `completed`, `max_chars`, `max_decisions`, `error`, and
`cancelled`. Incomplete Hangul components are stored separately from committed
text. An empty/whitespace-only translation ending in EOS is an error.

`decisionCount` includes a failed application attempt; `steps` contains successful
responses. Usage sums the token counts reported by successful decisions and is
not a billing estimate: failed requests and retries may add unreported usage.
Missing usage fields remain `null`. Duration includes retry waits and CLI callback
work; each step's duration measures its decision and output composition.

Native provider confidence is distinct from the selected option's probability.
Both are preserved without treating them as interchangeable across providers.
The SDK validates responses and accounts for provider-declared rounding; returned
probabilities are not normalized or fabricated by this experiment.

## Development

Run checks in this order before committing a feature:

```sh
npm run format
npm run lint
npm run format:check
npm run typecheck
npm test
```

`npm run check` combines Biome's recommended lint rules, formatting verification,
and import organization checks. Tests run offline with Node's built-in test
runner and mocked native HTTP. They cover both providers and all output languages,
every modern Hangul syllable, legal output transitions, generation limits,
BYOK authentication, retries, refusals, cancellation, comparisons, and report
export. They verify implementation behavior, not live translation quality.

For the preserved Python reference (Python 3.11+):

```sh
python -m ruff check run.py tests/test_legacy.py
python -m ruff format --check run.py tests/test_legacy.py
python -m unittest discover -s tests -p "test_*.py" -v
```

## Code map and references

- `src/providers.ts`: BYOK credentials, native SDK provider instances, deadlines,
  response normalization, and safe public errors.
- `src/output.ts`: output alphabets and Hangul composition state.
- `src/translate.ts`: sequential generation, bounds, traces, and token accounting.
- `src/compare.ts`: model/target/repetition matrix and summary calculations.
- `src/cli.ts`: arguments, local environment loading, streaming, and JSON reports.
- `run.py`: preserved Python baseline; it calls Jev directly and does not use the
  Vercel SDK or the multilingual CLI.

The AI SDK decision API is experimental; its contract can change even in patch
releases. Keep the lockfile and rerun checks when upgrading. API contracts and
model support were checked against these official references:

- [Vercel AI SDK decisions](https://ai-sdk.dev/docs/ai-sdk-core/decisions)
- [TypeSafe AI SDK provider](https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai)
- [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
- [OpenAI choice request limits](https://developers.openai.com/api/reference/resources/decisions/methods/create)
- [TypeSafe System One API](https://docs.typesafe.ai/api)
- [Unicode Hangul composition](https://www.unicode.org/versions/Unicode18.0.0/core-spec/chapter-3/)
