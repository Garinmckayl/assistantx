FROM python:3.12-slim

WORKDIR /app

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (for dashboard build + @agntor/sdk)
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
    scikit-learn \
    numpy \
    cryptography \
    gradient \
    gradient-adk \
    auth0-python \
    auth0-ai

# Node deps (@agntor/sdk)
COPY package.json ./
RUN npm install --omit=dev 2>/dev/null || true

# Build React dashboard
COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
RUN cd dashboard && npm install 2>/dev/null || true
COPY dashboard/ ./dashboard/
RUN cd dashboard && npm run build

# App source
COPY api/ ./api/
COPY .gradient/ ./.gradient/

# Expose AssistantX control plane port
EXPOSE 8000

# Health check for container orchestration
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8000/api/health || exit 1

CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]

