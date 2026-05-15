FROM python:3.12-slim

RUN useradd -m -u 1001 runner

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY server.py /app/server.py
COPY migrationkit /app/migrationkit
# Make the migrationkit package importable from anywhere inside the
# container (both the MCP server itself and user-script subprocesses
# spawned by run_python / run_python_background pick it up via PYTHONPATH).
ENV PYTHONPATH=/app
RUN mkdir -p /workspace /workspace/state && chown -R runner /workspace /app

USER runner
WORKDIR /workspace
EXPOSE 8000 8001
CMD ["python", "/app/server.py"]
