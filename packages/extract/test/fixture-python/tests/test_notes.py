from app.services.notes import NoteService


def test_create_trims_text():
    service = NoteService()
    assert service.create("  hi  ")["text"] == "hi"


class TestRemove:
    def test_remove_missing_is_quiet(self):
        NoteService().remove(42)
