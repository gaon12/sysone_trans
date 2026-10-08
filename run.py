#!/usr/bin/env python3

"""Legacy Korean-to-English experiment using native Jev Choice decisions.

Set TYPESAFE_API_KEY, then run python run.py "나는 사과를 좋아한다.".
Use --show-probabilities to inspect each next-character decision.
The TypeScript CLI is the primary entry point for new experiments."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

API_URL = "https://api.typesafe.ai/v1/systemone"


DEFAULT_MODEL = "jev-latest"


DEFAULT_MAX_CHARS = 500


DEFAULT_TIMEOUT_SECONDS = 30.0


DEFAULT_MAX_RETRIES = 3


@dataclass(frozen=True)
class CharacterOption:
    """A named output character and its description. None represents EOS."""

    label: str
    character: str | None
    description: str


@dataclass(frozen=True)
class JevDecision:
    """One selected character, with optional confidence and probabilities."""

    label: str
    character: str | None
    confidence: float | None
    probabilities: dict[str, float]


def build_character_options() -> list[CharacterOption]:
    """Build English letters, digits, separators, punctuation, and EOS."""

    options: list[CharacterOption] = []

    for character in "abcdefghijklmnopqrstuvwxyz":
        options.append(
            CharacterOption(
                label=f"LOWER_{character.upper()}",
                character=character,
                description=(
                    f"The next character is the lowercase English letter '{character}'."
                ),
            )
        )

    for character in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        options.append(
            CharacterOption(
                label=f"UPPER_{character}",
                character=character,
                description=(
                    f"The next character is the uppercase English letter '{character}'."
                ),
            )
        )

    for character in "0123456789":
        options.append(
            CharacterOption(
                label=f"DIGIT_{character}",
                character=character,
                description=f"The next character is the digit '{character}'.",
            )
        )

    options.append(
        CharacterOption(
            label="SPACE",
            character=" ",
            description="The next character is a single space.",
        )
    )

    punctuation: list[tuple[str, str, str]] = [
        (
            "PERIOD",
            ".",
            "The next character is a period/full stop '.'.",
        ),
        (
            "COMMA",
            ",",
            "The next character is a comma ','.",
        ),
        (
            "QUESTION_MARK",
            "?",
            "The next character is a question mark '?'.",
        ),
        (
            "EXCLAMATION_MARK",
            "!",
            "The next character is an exclamation mark '!'.",
        ),
        (
            "APOSTROPHE",
            "'",
            "The next character is an apostrophe/single quote '''.",
        ),
        (
            "DOUBLE_QUOTE",
            '"',
            "The next character is a double quote '\"'.",
        ),
        (
            "HYPHEN",
            "-",
            "The next character is a hyphen '-'.",
        ),
        (
            "COLON",
            ":",
            "The next character is a colon ':'.",
        ),
        (
            "SEMICOLON",
            ";",
            "The next character is a semicolon ';'.",
        ),
        (
            "LEFT_PAREN",
            "(",
            "The next character is a left parenthesis '('.",
        ),
        (
            "RIGHT_PAREN",
            ")",
            "The next character is a right parenthesis ')'.",
        ),
        (
            "SLASH",
            "/",
            "The next character is a slash '/'.",
        ),
        (
            "AMPERSAND",
            "&",
            "The next character is an ampersand '&'.",
        ),
        (
            "PERCENT",
            "%",
            "The next character is a percent sign '%'.",
        ),
        (
            "PLUS",
            "+",
            "The next character is a plus sign '+'.",
        ),
        (
            "DOLLAR",
            "$",
            "The next character is a dollar sign '$'.",
        ),
        (
            "AT_SIGN",
            "@",
            "The next character is an at sign '@'.",
        ),
        (
            "HASH",
            "#",
            "The next character is a hash sign '#'.",
        ),
        (
            "UNDERSCORE",
            "_",
            "The next character is an underscore '_'.",
        ),
        (
            "NEWLINE",
            "\n",
            "The next character is a newline.",
        ),
    ]

    for label, character, description in punctuation:
        options.append(
            CharacterOption(
                label=label,
                character=character,
                description=description,
            )
        )

    options.append(
        CharacterOption(
            label="EOS",
            character=None,
            description=(
                "The English translation is complete. "
                "Select this only when no more characters should be added."
            ),
        )
    )

    return options


class JevClient:
    """Call the TypeSafe System One API using the Python standard library."""

    def __init__(
        self,
        api_key: str,
        *,
        model: str = DEFAULT_MODEL,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        """Configure credentials, model, timeout, and retry count."""

        if not api_key:
            raise ValueError("API key must not be empty.")

        self.api_key = api_key
        self.model = model
        self.timeout_seconds = timeout_seconds
        self.max_retries = max_retries

    def decide_next_character(
        self,
        *,
        korean_source: str,
        english_prefix: str,
        options: list[CharacterOption],
    ) -> JevDecision:
        """Choose one character after an immutable English translation prefix."""

        option_by_label = {option.label: option for option in options}

        #

        #
        # {
        #     "LOWER_A": "The next character is ...",
        #     "SPACE": "The next character is ...",
        #     "EOS": "The translation is complete ..."
        # }
        criteria = {option.label: option.description for option in options}

        #

        state = {
            "task": (
                "Translate the Korean source text into natural, accurate English "
                "one character at a time."
            ),
            "korean_source": korean_source,
            "english_translation_so_far": english_prefix,
        }

        #

        #

        instructions = (
            "Choose exactly one option representing the NEXT CHARACTER of the "
            "natural and accurate English translation of `korean_source`. "
            "`english_translation_so_far` is an immutable prefix that has already "
            "been generated. Do not rewrite, restart, correct, or replace that "
            "prefix. Continue directly after its final character. "
            "Consider the meaning and grammar of the entire Korean source, not just "
            "local spelling. "
            "Choose EOS only if `english_translation_so_far` already forms a "
            "complete English translation and no additional character is needed."
        )

        payload = {
            "model": self.model,
            "state": state,
            "questions": {
                "next_character": {
                    "type": "choice",
                    "instructions": instructions,
                    "criteria": criteria,
                }
            },
        }

        response = self._post_json(payload)

        try:
            answer = response["answers"]["next_character"]
        except (KeyError, TypeError) as exc:
            raise RuntimeError(
                "Unexpected Jev API response: "
                + json.dumps(
                    response,
                    ensure_ascii=False,
                    indent=2,
                )
            ) from exc

        label = answer.get("choice")

        if not isinstance(label, str):
            raise RuntimeError(
                "Jev response did not contain a valid choice: "
                + json.dumps(
                    answer,
                    ensure_ascii=False,
                    indent=2,
                )
            )

        if label not in option_by_label:
            raise RuntimeError(f"Jev returned an unknown choice label: {label!r}")

        option = option_by_label[label]

        raw_confidence = answer.get("confidence")

        confidence: float | None

        if isinstance(raw_confidence, int | float):
            confidence = float(raw_confidence)
        else:
            confidence = None

        raw_probabilities = answer.get("probabilities", {})

        probabilities: dict[str, float] = {}

        if isinstance(raw_probabilities, dict):
            for probability_label, probability_value in raw_probabilities.items():
                if isinstance(probability_label, str) and isinstance(
                    probability_value, int | float
                ):
                    probabilities[probability_label] = float(probability_value)

        return JevDecision(
            label=label,
            character=option.character,
            confidence=confidence,
            probabilities=probabilities,
        )

    def _post_json(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Post JSON and retry temporary HTTP or network failures."""

        body = json.dumps(
            payload,
            ensure_ascii=False,
        ).encode("utf-8")

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "jev-char-translator/0.1",
        }

        for attempt in range(self.max_retries + 1):
            request = urllib.request.Request(
                API_URL,
                data=body,
                headers=headers,
                method="POST",
            )

            try:
                with urllib.request.urlopen(
                    request,
                    timeout=self.timeout_seconds,
                ) as response:
                    response_body = response.read().decode("utf-8")

                parsed = json.loads(response_body)

                if not isinstance(parsed, dict):
                    raise RuntimeError("Jev API returned a non-object JSON response.")

                return parsed

            except urllib.error.HTTPError as exc:
                try:
                    error_body = exc.read().decode(
                        "utf-8",
                        errors="replace",
                    )
                except Exception:
                    error_body = ""

                retryable_statuses = {
                    429,
                    500,
                    502,
                    503,
                    504,
                    529,
                }

                can_retry = (
                    exc.code in retryable_statuses and attempt < self.max_retries
                )

                if can_retry:
                    delay = self._get_retry_delay(
                        exc=exc,
                        attempt=attempt,
                    )

                    print(
                        (f"\nHTTP {exc.code}: retrying in {delay:.1f} seconds..."),
                        file=sys.stderr,
                    )

                    time.sleep(delay)
                    continue

                raise RuntimeError(
                    f"Jev API returned HTTP {exc.code}.\n{error_body}"
                ) from exc

            except urllib.error.URLError as exc:
                if attempt < self.max_retries:
                    delay = 2.0**attempt

                    print(
                        (
                            "\nNetwork error: "
                            f"{exc.reason}. "
                            f"Retrying in {delay:.1f} seconds..."
                        ),
                        file=sys.stderr,
                    )

                    time.sleep(delay)
                    continue

                raise RuntimeError(
                    f"Could not connect to Jev API: {exc.reason}"
                ) from exc

            except json.JSONDecodeError as exc:
                raise RuntimeError("Jev API returned invalid JSON.") from exc

        raise RuntimeError("Jev API request failed unexpectedly.")

    @staticmethod
    def _get_retry_delay(
        *,
        exc: urllib.error.HTTPError,
        attempt: int,
    ) -> float:
        """Prefer numeric Retry-After seconds; otherwise use exponential backoff."""

        retry_after = exc.headers.get("Retry-After")

        if retry_after is not None:
            try:
                return max(float(retry_after), 0.0)
            except ValueError:
                pass

        return 2.0**attempt


def print_top_probabilities(
    decision: JevDecision,
    options: list[CharacterOption],
    *,
    limit: int = 8,
) -> None:
    """Print the most likely character choices to standard error."""

    if not decision.probabilities:
        print("  probabilities: unavailable", file=sys.stderr)
        return

    option_by_label = {option.label: option for option in options}

    sorted_probabilities = sorted(
        decision.probabilities.items(),
        key=lambda item: item[1],
        reverse=True,
    )

    print("  top probabilities:", file=sys.stderr)

    for label, probability in sorted_probabilities[:limit]:
        option = option_by_label.get(label)

        if option is None:
            display = label
        elif option.character is None:
            display = "<EOS>"
        elif option.character == " ":
            display = "<SPACE>"
        elif option.character == "\n":
            display = "<NEWLINE>"
        else:
            display = repr(option.character)

        print(
            f"    {display:<12} {probability:>8.4%}",
            file=sys.stderr,
        )


def translate(
    client: JevClient,
    korean_source: str,
    *,
    max_chars: int,
    show_probabilities: bool,
) -> str:
    """Append one chosen character at a time until EOS or the decision limit."""

    options = build_character_options()

    if len(options) > 255:
        raise RuntimeError(f"Too many Choice options: {len(options)} > 255")

    english_prefix = ""

    print("\nTranslation:")
    print("> ", end="", flush=True)

    for step in range(1, max_chars + 1):
        decision = client.decide_next_character(
            korean_source=korean_source,
            english_prefix=english_prefix,
            options=options,
        )

        if show_probabilities:
            print(
                (
                    f"\n\n[step {step}] "
                    f"choice={decision.label} "
                    f"confidence={decision.confidence}"
                ),
                file=sys.stderr,
            )

            print_top_probabilities(
                decision,
                options,
            )

            print(
                f"\n> {english_prefix}",
                end="",
                flush=True,
            )

        if decision.character is None:
            print()
            return english_prefix

        english_prefix += decision.character

        print(
            decision.character,
            end="",
            flush=True,
        )

    print()

    raise RuntimeError(
        f"Translation did not reach EOS within {max_chars} generated characters."
    )


def parse_arguments() -> argparse.Namespace:
    """Read the source text and experiment settings from the command line."""

    parser = argparse.ArgumentParser(
        description=(
            "Experimental Korean-to-English translator that makes "
            "Jev choose one output character at a time."
        )
    )

    parser.add_argument(
        "text",
        nargs="?",
        help=(
            "Korean text to translate. "
            "If omitted, the program asks for input interactively."
        ),
    )

    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=(f"Jev model name. Default: {DEFAULT_MODEL}"),
    )

    parser.add_argument(
        "--max-chars",
        type=int,
        default=DEFAULT_MAX_CHARS,
        help=(
            "Maximum number of generated characters before aborting. "
            f"Default: {DEFAULT_MAX_CHARS}"
        ),
    )

    parser.add_argument(
        "--show-probabilities",
        action="store_true",
        help=(
            "Print the highest-probability character choices for every generation step."
        ),
    )

    return parser.parse_args()


def main() -> int:
    """Validate input, run the experiment, and return a process exit code."""

    args = parse_arguments()

    api_key = os.environ.get("TYPESAFE_API_KEY")

    if not api_key:
        print(
            ("Error: TYPESAFE_API_KEY environment variable is not set."),
            file=sys.stderr,
        )
        return 1

    if args.max_chars <= 0:
        print(
            "Error: --max-chars must be greater than 0.",
            file=sys.stderr,
        )
        return 1

    korean_source = args.text

    if korean_source is None:
        korean_source = input("Korean text: ").strip()

    if not korean_source:
        print(
            "Error: source text must not be empty.",
            file=sys.stderr,
        )
        return 1

    options = build_character_options()

    print(f"Model: {args.model}")
    print(f"Choice options: {len(options)}")
    print(f"Korean source: {korean_source}")

    client = JevClient(
        api_key=api_key,
        model=args.model,
    )

    try:
        result = translate(
            client,
            korean_source,
            max_chars=args.max_chars,
            show_probabilities=args.show_probabilities,
        )

    except KeyboardInterrupt:
        print(
            "\nInterrupted.",
            file=sys.stderr,
        )
        return 130

    except Exception as exc:
        print(
            f"\nError: {exc}",
            file=sys.stderr,
        )
        return 1

    print()
    print("Final translation:")
    print(result)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
