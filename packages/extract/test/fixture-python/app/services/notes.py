import os

MAX_LENGTH = int(os.environ.get("NOTES_MAX_LENGTH", "500"))


class NoteService:
    def __init__(self):
        self._notes: dict[int, dict] = {}

    def create(self, text: str) -> dict:
        text = _clean(text)
        note = {"id": len(self._notes) + 1, "text": text}
        self._notes[note["id"]] = note
        return note

    def list(self) -> list[dict]:
        return list(self._notes.values())

    def remove(self, note_id: int) -> None:
        # TODO: raise when the note is missing
        self._notes.pop(note_id, None)


def _clean(text: str) -> str:
    return text.strip()[:MAX_LENGTH]
