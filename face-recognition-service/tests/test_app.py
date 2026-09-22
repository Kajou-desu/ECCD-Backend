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


def test_refuses_to_start_without_a_strong_key(monkeypatch):
    import importlib
    monkeypatch.setenv("RECOGNITION_SERVICE_KEY", "short")
    with pytest.raises(RuntimeError):
        importlib.reload(service)
    monkeypatch.setenv("RECOGNITION_SERVICE_KEY", KEY)
    importlib.reload(service)
