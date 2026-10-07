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

    def test_reload_waits_for_the_enrol_lock(self, client, monkeypatch):
        import asyncio
        calls = []
        monkeypatch.setattr(recognizer, "load_known_faces", lambda root: calls.append(root) or service.app.state.known)

        async def hold_lock_then_reload():
            async with service.app.state.enroll_lock:
                task = asyncio.create_task(service.reload_known_faces())
                await asyncio.sleep(0.05)
                assert not task.done() and calls == []
            return await task

        assert asyncio.run(hold_lock_then_reload()) == {"students": len(service.app.state.known)}
        assert len(calls) == 1

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

    @pytest.mark.parametrize("bad_id", ["abc", "-5", "1.5", "5 ", "../5", "0000000001x", "0", "01", "007"])
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

    def test_rejects_a_body_larger_than_its_declared_content_length(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        monkeypatch.setattr(service, "ENROLL_MAX_BODY_BYTES", 1000)
        r = client.post(
            "/enroll/5",
            headers={**AUTH, "Content-Length": "100", "Content-Type": "multipart/form-data; boundary=b"},
            content=b"--b\r\n" + b"x" * 5000,
        )
        assert r.status_code == 413
        assert not (tmp_path / "5").exists()

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
        assert r.json() == {
            "studentId": 5,
            "photosReceived": 1,
            "photosUsable": 1,
            "photosRejected": 0,
            "enrolled": True,
        }
        assert (tmp_path / "5" / "0.jpg").exists()

    def test_photos_without_exactly_one_face_are_not_stored(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        # Photos are encoded in name order: 0 -> one face, 1 -> two faces, 2 -> none.
        results = iter([[np.zeros(128)], [np.zeros(128), np.ones(128)], []])
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: next(results))

        r = self.enroll(client, 5, [self.photo(name=f"p{i}.jpg") for i in range(3)])
        assert r.status_code == 200
        assert r.json() == {
            "studentId": 5,
            "photosReceived": 3,
            "photosUsable": 1,
            "photosRejected": 2,
            "enrolled": True,
        }
        # Only the photo that is actually used for matching is kept on disk.
        assert [p.name for p in (tmp_path / "5").iterdir()] == ["0.jpg"]

    def test_no_usable_face_is_rejected_and_keeps_the_existing_enrollment(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: [])  # nobody detected
        (tmp_path / "5").mkdir()
        (tmp_path / "5" / "good.jpg").write_bytes(b"previous-good-photo")

        r = self.enroll(client, 5, [self.photo()])
        assert r.status_code == 422
        # A bad upload must never wipe out a working enrollment.
        assert [p.name for p in (tmp_path / "5").iterdir()] == ["good.jpg"]
        assert not (tmp_path / "5.tmp").exists()

    def test_accepts_png_alongside_jpeg(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: [np.zeros(128)])
        ok, buf = cv2.imencode(".png", np.full((48, 64, 3), 127, dtype=np.uint8))
        assert ok
        png = buf.tobytes()
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
        # face_encodings runs inside the per-photo try/except, which swallows the
        # error and skips that photo — so nothing is usable: 422, not a raw 500.
        assert r.status_code == 422
        assert "secret" not in r.text and "/srv" not in r.text


def test_refuses_to_start_without_a_strong_key(monkeypatch):
    import importlib
    monkeypatch.setenv("RECOGNITION_SERVICE_KEY", "short")
    with pytest.raises(RuntimeError):
        importlib.reload(service)
    monkeypatch.setenv("RECOGNITION_SERVICE_KEY", KEY)
    importlib.reload(service)


class TestEnrollHardening:
    enroll = TestEnroll.enroll
    photo = TestEnroll.photo

    def test_oversized_dimensions_are_rejected_before_anything_is_written(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        huge = jpeg(width=service.ENROLL_MAX_DIMENSION + 1, height=8)
        r = self.enroll(client, 5, [self.photo(data=huge)])
        assert r.status_code == 400
        assert not (tmp_path / "5").exists() and not (tmp_path / "5.tmp").exists()

    def test_enrolling_one_student_does_not_re_encode_everyone_else(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: [np.zeros(128)])
        def no_full_reload(root):
            raise AssertionError("full reload on enrol")
        monkeypatch.setattr(recognizer, "load_known_faces", no_full_reload)
        r = self.enroll(client, 5, [self.photo()])
        assert r.status_code == 200 and r.json()["enrolled"] is True
        assert 5 in service.app.state.known.ids

    def test_delete_removes_photos_and_the_in_memory_encoding(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        monkeypatch.setattr(recognizer.face_recognition, "face_encodings", lambda img: [np.zeros(128)])
        self.enroll(client, 5, [self.photo()])
        assert 5 in service.app.state.known.ids

        r = client.delete("/enroll/5", headers=AUTH)
        assert r.status_code == 200 and r.json() == {"studentId": 5, "removed": True}
        assert not (tmp_path / "5").exists()
        assert 5 not in service.app.state.known.ids

    def test_delete_is_idempotent(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        r = client.delete("/enroll/9", headers=AUTH)
        assert r.status_code == 200 and r.json() == {"studentId": 9, "removed": False}

    def test_delete_requires_the_key(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        assert client.delete("/enroll/5").status_code == 401

    @pytest.mark.parametrize("bad_id", ["abc", "-5", "1.5", "0000000001x", "0", "01"])
    def test_delete_rejects_a_non_numeric_student_id(self, client, tmp_path, monkeypatch, bad_id):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        assert client.delete(f"/enroll/{bad_id}", headers=AUTH).status_code in (400, 404)


class TestViewEnrolledPhotos:
    """GET /enroll/{id}/photos[/{index}]: read back what is stored, nothing else."""

    PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16

    @pytest.fixture()
    def store(self, tmp_path, monkeypatch):
        monkeypatch.setattr(service, "KNOWN_FACES_DIR", str(tmp_path))
        student = tmp_path / "5"
        student.mkdir()
        (student / "0.jpg").write_bytes(jpeg())
        (student / "1.png").write_bytes(self.PNG)
        (student / "notes.txt").write_text("not an image")
        (tmp_path / "secret.jpg").write_bytes(jpeg())  # outside any student folder
        return tmp_path

    def test_requires_the_service_key(self, client, store):
        assert client.get("/enroll/5/photos").status_code == 401
        assert client.get("/enroll/5/photos/0").status_code == 401

    def test_count_lists_images_only(self, client, store):
        r = client.get("/enroll/5/photos", headers=AUTH)
        assert r.status_code == 200 and r.json() == {"studentId": 5, "count": 2}

    def test_unknown_student_has_zero_photos(self, client, store):
        assert client.get("/enroll/9/photos", headers=AUTH).json()["count"] == 0

    def test_serves_bytes_with_the_sniffed_type_and_no_caching(self, client, store):
        r = client.get("/enroll/5/photos/0", headers=AUTH)
        assert r.status_code == 200 and r.content == jpeg()
        assert r.headers["content-type"] == "image/jpeg"
        assert "no-store" in r.headers["cache-control"]
        assert client.get("/enroll/5/photos/1", headers=AUTH).headers["content-type"] == "image/png"

    def test_out_of_range_is_404(self, client, store):
        assert client.get("/enroll/5/photos/2", headers=AUTH).status_code == 404

    @pytest.mark.parametrize("bad", ["abc", "-1", "1.5", "100", "%2e%2e", "0%2f..%2fsecret.jpg"])
    def test_bad_index_never_reads_outside_the_folder(self, client, store, bad):
        r = client.get(f"/enroll/5/photos/{bad}", headers=AUTH)
        assert r.status_code in (400, 404)
        assert r.content != jpeg() or bad == "0"

    @pytest.mark.parametrize("bad_id", ["abc", "-1", "1234567890", "5%2f..%2f7", "0", "05"])
    def test_bad_student_id_is_rejected(self, client, store, bad_id):
        assert client.get(f"/enroll/{bad_id}/photos", headers=AUTH).status_code in (400, 404)

    def test_a_non_image_file_is_never_served(self, client, store):
        (store / "5" / "0.jpg").write_text("<html>not a jpeg</html>")
        assert client.get("/enroll/5/photos/0", headers=AUTH).status_code == 404
