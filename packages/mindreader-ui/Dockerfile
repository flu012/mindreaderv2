FROM node:22-slim AS base
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server/ ./server/
COPY ui/dist/ ./ui/dist/

EXPOSE 18900
ENV NODE_ENV=production
CMD ["node", "server/start.js"]
