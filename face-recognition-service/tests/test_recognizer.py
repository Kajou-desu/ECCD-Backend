import numpy as np
import pytest

import recognizer
from recognizer import KnownFaces


def enc(*head):
    """A 128-d vector whose first components are `head` (rest zero)."""
    v = np.zeros(128)
    v[: len(head)] = head
    return v


def known():
    return KnownFaces([10, 20, 30], np.array([enc(0.0), enc(1.0), enc(3.0)]))


class TestMatch:
    def test_returns_nearest_student_distance_and_margin(self):
        m = known().match(enc(0.1))
        assert m.student_id == 10
        assert m.distance == pytest.approx(0.1)
        assert m.margin == pytest.approx(0.9 - 0.1)  # runner-up (20) is 0.9 away

    def test_margin_is_small_for_look_alikes(self):
        k = KnownFaces([1, 2], np.array([enc(0.50), enc(0.52)]))
        assert k.match(enc(0.5)).margin == pytest.approx(0.02)

    def test_margin_is_none_with_a_single_enrolled_student(self):
        m = KnownFaces([7], np.array([enc(0.0)])).match(enc(0.2))
        assert m.student_id == 7 and m.margin is None

    def test_nobody_enrolled_matches_nobody(self):
        m = KnownFaces([], np.empty((0, 128))).match(enc(0.0))
        assert (m.student_id, m.distance, m.margin) == (None, None, None)

    def test_reports_the_nearest_even_when_far_it_does_not_apply_thresholds(self):
        m = known().match(enc(50.0))
        assert m.student_id == 30 and m.distance > 40  # the backend decides that's too far


class TestLoadKnownFaces:
    def test_missing_directory_means_nobody_enrolled(self, tmp_path):
        assert len(recognizer.load_known_faces(str(tmp_path / "nope"))) == 0

    def test_only_numeric_real_directories_with_image_files_are_read(self, tmp_path, monkeypatch):
        (tmp_path / "12").mkdir()
        (tmp_path / "12" / "a.jpg").write_bytes(b"x")
        (tmp_path / "12" / "notes.txt").write_bytes(b"x")          # not an image
        (tmp_path / "Maria Santos").mkdir()                          # named folder: ignored
        (tmp_path / "Maria Santos" / "a.jpg").write_bytes(b"x")
        (tmp_path / "..hidden").mkdir()
        (tmp_path / "..hidden" / "a.jpg").write_bytes(b"x")
        (tmp_path / "loose.jpg").write_bytes(b"x")                   # file, not a folder
        outside = tmp_path.parent / "outside_target"
        outside.mkdir(exist_ok=True)
        (outside / "a.jpg").write_bytes(b"x")
        (tmp_path / "99").symlink_to(outside, target_is_directory=True)  # symlinked dir: ignored

        seen = []
        monkeypatch.setattr(recognizer.face_recognition, "load_image_file", lambda p: seen.append(p) or p)
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: [enc(1.0)])

        kf = recognizer.load_known_faces(str(tmp_path))
        assert kf.ids == [12]
        assert len(seen) == 1 and seen[0].endswith("12/a.jpg")

    def test_averages_a_students_photos(self, tmp_path, monkeypatch):
        (tmp_path / "5").mkdir()
        for name in ("a.jpg", "b.jpg"):
            (tmp_path / "5" / name).write_bytes(b"x")
        vectors = iter([enc(0.0), enc(2.0)])
        monkeypatch.setattr(recognizer.face_recognition, "load_image_file", lambda p: p)
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: [next(vectors)])
        kf = recognizer.load_known_faces(str(tmp_path))
        assert kf.encodings[0][0] == pytest.approx(1.0)

    @pytest.mark.parametrize("found", [0, 2])
    def test_photos_without_exactly_one_face_are_skipped(self, tmp_path, monkeypatch, found):
        (tmp_path / "5").mkdir()
        (tmp_path / "5" / "a.jpg").write_bytes(b"x")
        monkeypatch.setattr(recognizer.face_recognition, "load_image_file", lambda p: p)
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: [enc(1.0)] * found)
        assert len(recognizer.load_known_faces(str(tmp_path))) == 0

    def test_one_corrupt_photo_does_not_abort_everyone(self, tmp_path, monkeypatch):
        for sid in ("1", "2"):
            (tmp_path / sid).mkdir()
            (tmp_path / sid / "a.jpg").write_bytes(b"x")

        def load(path):
            if "/1/" in path:
                raise OSError("corrupt")
            return path

        monkeypatch.setattr(recognizer.face_recognition, "load_image_file", load)
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: [enc(1.0)])
        assert recognizer.load_known_faces(str(tmp_path)).ids == [2]

    def test_oversized_photos_are_skipped(self, tmp_path, monkeypatch):
        (tmp_path / "5").mkdir()
        (tmp_path / "5" / "big.jpg").write_bytes(b"x" * (recognizer.MAX_ENROLL_IMAGE_BYTES + 1))
        called = []
        monkeypatch.setattr(recognizer.face_recognition, "load_image_file", lambda p: called.append(p))
        assert len(recognizer.load_known_faces(str(tmp_path))) == 0
        assert called == []
