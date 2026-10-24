FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# Mount a volume here so client data survives restarts.
VOLUME ["/app/data"]
EXPOSE 3000
USER node
CMD ["npm", "start"]
