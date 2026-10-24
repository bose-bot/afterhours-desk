FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app

# Mount a volume at /app/data so client data survives restarts.
VOLUME ["/app/data"]
EXPOSE 3000

# Hosts mount volumes as root, so fix ownership at start, then drop to the unprivileged node user.
# If dropping privileges isn't possible on this host, run as-is rather than fail to start.
CMD ["sh", "-c", "chown -R node:node /app/data 2>/dev/null || true; if command -v setpriv >/dev/null && setpriv --reuid=node --regid=node --init-groups true 2>/dev/null; then exec setpriv --reuid=node --regid=node --init-groups node --disable-warning=ExperimentalWarning src/index.js; else exec node --disable-warning=ExperimentalWarning src/index.js; fi"]
