FROM python:3.11-slim

LABEL maintainer="Mnemo Project"
LABEL description="Graphiti service - Knowledge graph bridge for Mnemo"

WORKDIR /app

# Install system dependencies required by some Python packages
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install --no-cache-dir \
    fastapi==0.115.* \
    uvicorn[standard]==0.34.* \
    neo4j==5.* \
    httpx==0.28.* \
    graphiti-core==0.* \
    pydantic==2.*

# Copy service code
COPY graphiti-service.py .

EXPOSE 18799

# Run with 0.0.0.0 so it's accessible from outside the container
CMD ["python", "graphiti-service.py"]
