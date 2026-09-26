import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

import app as service
import recognizer

KEY = service.SERVICE_KEY
AUTH = {"X-Service-Key": KEY}


def jpeg(width=64, height=48):
    ok, buf = cv2.imencode(".jpg", np.full((height, width, 3), 127, dtype=np.uint8))
    assert ok
    return buf.tobytes()


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(
        recognizer, "analyze",
        lambda rgb, known: [{"box": [1, 2, 3, 4], "studentId": 7, "distance": 0.4, "margin": 0.2}],
    )
    return TestClient(service.app)


def post(client, data, headers=AUTH, content_type="image/jpeg"):
    return client.post("/recognize", headers=headers, files={"frame": ("f.jpg", data, content_type)})


class TestAuth:
    def test_health_is_open_and_reveals_nothing(self, client):
        r = client.get("/health")
        assert r.status_code == 200 and r.json() == {"status": "ok"}

    @pytest.mark.parametrize("headers", [{}, {"X-Service-Key": "wrong"}, {"X-Service-Key": ""}, {"X-Service-Key": KEY[:-1]}])
    def test_recognize_requires_the_exact_key(self, client, headers):
        assert post(client, jpeg(), headers=headers).status_code == 401

    def test_reload_requires_the_key_too(self, client):
        assert client.post("/reload").status_code == 401
        assert client.post("/reload", headers=AUTH).status_code == 200

    def test_unauthenticated_upload_is_rejected_before_it_is_parsed(self, client):
        # Even a malformed multipart body gets 401, not a parse error: auth ran first.
        r = client.post("/recognize", content=b"not multipart", headers={"Content-Type": "multipart/form-data; boundary=x"})
        assert r.status_code == 401

    def test_docs_endpoints_are_not_exposed(self, client):
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(path, headers=AUTH).status_code == 404


class TestLimits:
    def test_rejects_a_declared_oversized_body_up_front(self, client):
        r = client.post("/recognize", headers={**AUTH, "Content-Length": str(10 * 1024 * 1024)}, content=b"x")
        assert r.status_code == 413

    def test_rejects_an_oversized_frame(self, client):
        assert post(client, b"\xff\xd8\xff" + b"0" * (service.MAX_FRAME_BYTES + 10)).status_code == 413

    def test_requires_a_content_length(self, client):
        def chunks():
            yield b"abc"
        r = client.post("/recognize", headers=AUTH, content=chunks())
        assert r.status_code == 411

    def test_rejects_oversized_dimensions(self, client):
        assert post(client, jpeg(width=service.MAX_IMAGE_DIMENSION + 1, height=8)).status_code == 400


class TestContent:
    def test_rejects_non_jpeg_bytes_regardless_of_declared_type(self, client):
        assert post(client, b"<html><script>alert(1)</script></html>").status_code == 400
        assert post(client, b"\x89PNG\r\n\x1a\n" + b"0" * 50).status_code == 400

    def test_rejects_a_VALID_image_that_is_not_a_jpeg(self, client):
        # Garbage fails to decode anyway; a well-formed PNG/BMP would decode fine,
        # so only the magic-byte check stops other formats reaching the decoder.
        for ext in (".png", ".bmp"):
            ok, buf = cv2.imencode(ext, np.full((20, 20, 3), 90, dtype=np.uint8))
            assert ok
            r = post(client, buf.tobytes())
            assert r.status_code == 400 and r.json() == {"detail": "Frame must be a JPEG image"}, ext

    def test_rejects_a_corrupt_jpeg(self, client):
        assert post(client, b"\xff\xd8\xff" + b"garbage").status_code == 400

    def test_missing_frame_field_is_a_client_error(self, client):
        r = client.post("/recognize", headers=AUTH, files={"other": ("f.jpg", jpeg(), "image/jpeg")})
        assert r.status_code == 422


class TestRecognize:
    def test_returns_dimensions_and_faces(self, client):
        r = post(client, jpeg(64, 48))
        assert r.status_code == 200
        assert r.json() == {
            "width": 64, "height": 48,
            "faces": [{"box": [1, 2, 3, 4], "studentId": 7, "distance": 0.4, "margin": 0.2}],
        }

    def test_internal_errors_are_generic(self, client, monkeypatch):
        def boom(rgb, known):
            raise RuntimeError("secret internal detail /srv/Images/12")
        monkeypatch.setattr(recognizer, "analyze", boom)
        r = post(client, jpeg())
        assert r.status_code == 500
        assert r.json() == {"detail": "Recognition failed"}
        assert "secret" not in r.text and "/srv" not in r.text


class TestEnroll:
    """POST /enroll/{student_id}: replaces a student's whole photo folder."""

    def enroll(self, client, student_id, files, headers=AUTH, content_length=None):
        kwargs = {"headers": headers, "files": files}
        if content_length is not None:
            kwargs["headers"] = {**headers, "Content-Length": str(content_length)}
            kwargs["content"] = b"x"
            return client.post(f"/enroll/{student_id}", **kwargs)
        return client.post(f"/enroll/{student_id}", **kwargs)

    def photo(self, name="a.jpg", content_type="image/jpeg", data=None):
        return ("photos", (name, data if data is not None else jpeg(), content_type))

    def test_requires_the_exact_key(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        r = client.post("/enroll/5", files=[self.photo()])
        assert r.status_code == 401

    @pytest.mark.parametrize("bad_id", ["abc", "-5", "1.5", "5 ", "../5", "0000000001x"])
    def test_rejects_a_non_numeric_student_id(self, client, tmp_path, monkeypatch, bad_id):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        r = client.post(f"/enroll/{bad_id}", headers=AUTH, files=[self.photo()])
        assert r.status_code in (400, 404)  # 404 if FastAPI itself rejects the path segment (e.g. a "/")

    def test_rejects_zero_photos(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        r = client.post("/enroll/5", headers=AUTH, files=[])
        assert r.status_code in (400, 422)  # 422 if FastAPI rejects the missing required field first

    def test_rejects_more_than_the_max_photos(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        photos = [self.photo(name=f"p{i}.jpg") for i in range(service.ENROLL_MAX_IMAGES + 1)]
        assert self.enroll(client, 5, photos).status_code == 400

    def test_rejects_a_declared_oversized_body_up_front(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        r = self.enroll(client, 5, None, content_length=service.ENROLL_MAX_BODY_BYTES + 1)
        assert r.status_code == 413

    def test_rejects_an_oversized_single_photo(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        big = b"\xff\xd8\xff" + b"0" * (recognizer.MAX_ENROLL_IMAGE_BYTES + 10)
        r = self.enroll(client, 5, [self.photo(data=big)])
        assert r.status_code == 413
        assert not (tmp_path / "5").exists()

    def test_rejects_non_image_bytes_regardless_of_declared_type(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        bad = self.photo(data=b"<html><script>alert(1)</script></html>")
        r = self.enroll(client, 5, [bad])
        assert r.status_code == 400
        assert not (tmp_path / "5").exists()

    def test_enrolled_true_when_a_photo_has_exactly_one_face(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: [np.zeros(128)])
        r = self.enroll(client, 5, [self.photo()])
        assert r.status_code == 200
        assert r.json() == {"studentId": 5, "photosReceived": 1, "enrolled": True}
        assert (tmp_path / "5" / "0.jpg").exists()

    def test_enrolled_false_when_no_photo_has_a_usable_face(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: [])  # nobody detected
        r = self.enroll(client, 5, [self.photo()])
        assert r.status_code == 200
        assert r.json() == {"studentId": 5, "photosReceived": 1, "enrolled": False}
        assert (tmp_path / "5" / "0.jpg").exists()  # the photo is still stored; just not usable yet

    def test_accepts_png_alongside_jpeg(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: [np.zeros(128)])
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 20
        r = self.enroll(client, 5, [self.photo(), self.photo(name="b.png", content_type="image/png", data=png)])
        assert r.status_code == 200
        assert sorted(p.name for p in (tmp_path / "5").iterdir()) == ["0.jpg", "1.png"]

    def test_replaces_the_previous_photo_set_atomically(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: [np.zeros(128)])
        (tmp_path / "5").mkdir()
        (tmp_path / "5" / "old-photo.jpg").write_bytes(b"stale")

        r = self.enroll(client, 5, [self.photo()])
        assert r.status_code == 200
        remaining = sorted(p.name for p in (tmp_path / "5").iterdir())
        assert remaining == ["0.jpg"]  # the old photo is gone, not just supplemented
        assert not (tmp_path / "5.tmp").exists()  # no leftover temp directory

    def test_a_failure_during_the_atomic_swap_does_not_touch_the_existing_folder(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: [np.zeros(128)])
        (tmp_path / "5").mkdir()
        (tmp_path / "5" / "old-photo.jpg").write_bytes(b"stale")

        def flaky_replace(src, dst):
            raise OSError("disk full")

        # Scoped to the one call site (the final rename-in), unlike patching
        # builtins.open, which would also intercept unrelated file I/O done by
        # the ASGI stack while handling this same request.
        real_replace = service.os.replace

        def flaky_then_real(src, dst):
            # Fail only on the critical swap-in (tmp -> student_dir); let the
            # "move the existing folder aside" replace succeed normally, same
            # as it would in a real partial-failure.
            if str(src).endswith(".tmp"):
                raise OSError("disk full")
            return real_replace(src, dst)

        monkeypatch.setattr(service.os, "replace", flaky_then_real)
        r = self.enroll(client, 5, [self.photo()])
        assert r.status_code == 500
        assert [p.name for p in (tmp_path / "5").iterdir()] == ["old-photo.jpg"]  # restored, not lost
        assert not (tmp_path / "5.tmp").exists()  # temp dir cleaned up
        assert not (tmp_path / "5.old").exists()  # rolled back, nothing left dangling

    def test_success_leaves_no_tmp_or_old_directory_behind(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: [np.zeros(128)])
        (tmp_path / "5").mkdir()
        (tmp_path / "5" / "old-photo.jpg").write_bytes(b"stale")

        r = self.enroll(client, 5, [self.photo()])
        assert r.status_code == 200
        assert [p.name for p in (tmp_path / "5").iterdir()] == ["0.jpg"]
        assert not (tmp_path / "5.tmp").exists()
        assert not (tmp_path / "5.old").exists()

    def test_internal_errors_are_generic(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))

        def boom(rgb):
            raise RuntimeError("secret internal detail /srv/Images/5")

        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: boom(img))
        r = self.enroll(client, 5, [self.photo()])
        # face_encodings only runs inside load_known_faces's per-photo try/except,
        # which swallows it and just skips that photo — so this is 200/enrolled: false,
        # not a 500. This test documents that behaviour rather than a raw crash.
        assert r.status_code == 200
        assert r.json()["enrolled"] is False
        assert "secret" not in r.text and "/srv" not in r.text


def test_refuses_to_start_without_a_strong_key(monkeypatch):
    import importlib
    monkeypatch.setenv("RECOGNITION_SERVICE_KEY", "short")
    with pytest.raises(RuntimeError):
        importlib.reload(service)
    monkeypatch.setenv("RECOGNITION_SERVICE_KEY", KEY)
    importlib.reload(service)
