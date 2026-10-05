# Face-recognition service image (e.g. for Railway). dlib compiles from source
# here, which is slow and needs a few GB of RAM.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

# Build tools for dlib (kept in the image for simplicity; it is just larger).
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential cmake \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py recognizer.py ./
COPY --chmod=755 entrypoint.sh /entrypoint.sh

# Enrolled photos (children's biometric data) live here: mount a persistent
# volume at /data, or every redeploy un-enrolls everyone.
RUN useradd --create-home app && mkdir -p /data/Images && chown -R app /data
ENV KNOWN_FACES_DIR=/data/Images

# No `USER app` here on purpose: Railway mounts the volume as root and hides the
# chown above, so entrypoint.sh (root) fixes the volume's ownership and then
# drops to `app` before the service starts. The service itself never runs as root.
ENTRYPOINT ["/entrypoint.sh"]

EXPOSE 8001
# One worker only: enrolled encodings are held in this process's memory.
# 0.0.0.0 is required inside a container; never publish this port publicly.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
