FROM python:3.12-slim

WORKDIR /app

# Install system deps (needed by docker-py for socket access)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (for @agntor/sdk shim)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Python deps
COPY pyproject.toml ./
RUN pip install --no-cache-dir \
    fastapi \
    "uvicorn[standard]" \
    httpx \
    websockets \
    docker \
    boto3 \
    pydantic \
    python-dotenv \
    gradient \
    gradient-adk

# Node deps (@agntor/sdk)
COPY package.json ./
RUN npm install --omit=dev 2>/dev/null || true

# App source
COPY api/ ./api/
COPY .gradient/ ./.gradient/
COPY dashboard/dist/ ./dashboard/dist/

# Expose AssistantX control plane port
EXPOSE 8000

CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
