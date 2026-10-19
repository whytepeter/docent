from flask import Blueprint, jsonify, request

from app.services.notes import NoteService

bp = Blueprint("notes", __name__)
service = NoteService()


@bp.route("/notes", methods=["GET", "POST"])
def notes():
    if request.method == "POST":
        note = service.create(request.json["text"])
        return jsonify(note), 201
    return jsonify(service.list())


@bp.delete("/notes/<int:note_id>")
def delete_note(note_id: int):
    service.remove(note_id)
    return "", 204
