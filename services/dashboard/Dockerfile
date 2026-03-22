FROM node:20-slim

LABEL maintainer="Mnemo Project"
LABEL description="Mnemo Dashboard - Web UI for memory inspection"

WORKDIR /app

# Install a minimal static server for now; will be replaced with full app
RUN npm install -g serve@14

# Copy dashboard source
COPY index.html .
COPY server.js .

EXPOSE 18800

CMD ["node", "server.js"]
