FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/matplotlib \
    IPYTHONDIR=/tmp/ipython \
    HOME=/sandbox

RUN useradd --uid 1000 --create-home --home-dir /sandbox --shell /bin/bash sandbox

WORKDIR /sandbox

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

COPY runner.py /sandbox/runner.py
RUN chown -R sandbox:sandbox /sandbox

USER sandbox

ENTRYPOINT ["python", "-u", "/sandbox/runner.py"]
