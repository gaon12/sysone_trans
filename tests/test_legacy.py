"""Offline regression tests for the original Python experiment."""

import contextlib
import io
import unittest

from run import JevClient, JevDecision, translate


class ScriptedClient(JevClient):
    """Record prefixes and return fixed decisions without making HTTP requests."""

    def __init__(self, characters: list[str | None]) -> None:
        super().__init__("test-key")
        self.characters = iter(characters)
        self.prefixes: list[str] = []

    def decide_next_character(self, *, korean_source, english_prefix, options):
        self.prefixes.append(english_prefix)
        character = next(self.characters)
        option = next(option for option in options if option.character == character)
        return JevDecision(option.label, character, None, {})


class LegacyTranslationTests(unittest.TestCase):
    def test_continues_the_prefix_and_stops_on_eos(self) -> None:
        client = ScriptedClient(["H", "i", ".", None])
        with contextlib.redirect_stdout(io.StringIO()):
            result = translate(client, "안녕", max_chars=10, show_probabilities=False)
        self.assertEqual(result, "Hi.")
        self.assertEqual(client.prefixes, ["", "H", "Hi", "Hi."])

    def test_stops_when_the_model_never_selects_eos(self) -> None:
        client = ScriptedClient(["a", "a"])
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "did not reach EOS"):
                translate(client, "안녕", max_chars=2, show_probabilities=False)
        self.assertEqual(len(client.prefixes), 2)

    def test_rejects_a_choice_outside_the_supplied_candidates(self) -> None:
        client = JevClient("test-key")
        client._post_json = lambda payload: {
            "answers": {"next_character": {"choice": "UNKNOWN"}}
        }
        with self.assertRaisesRegex(RuntimeError, "unknown choice label"):
            from run import build_character_options

            client.decide_next_character(
                korean_source="안녕",
                english_prefix="",
                options=build_character_options(),
            )


if __name__ == "__main__":
    unittest.main()
