FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MODELING_ARTIFACT_ROOT=/tmp/openvac-modeling/artifacts

RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
      libgl1 \
      libglu1-mesa \
      libsm6 \
      libxext6 \
      libxrender1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 openvac \
    && useradd --system --uid 10001 --gid openvac --home /app openvac

WORKDIR /app
COPY pyproject.toml ./
COPY app ./app
COPY tests/fixtures/rotary_vane_pump_v1.json ./tests/fixtures/rotary_vane_pump_v1.json
RUN python -m pip install --no-cache-dir .

RUN chown -R openvac:openvac /app

USER openvac
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
