# Production image for Express API and BullMQ worker (same image, different start command).
FROM node:20-bookworm-slim AS build
WORKDIR /app

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY backend/package.json backend/
COPY frontend/package.json frontend/

RUN npm ci

COPY packages/contracts packages/contracts
COPY backend backend

# prisma generate reads DATABASE_URL from the schema; a dummy value is enough at build time.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
RUN npm run build:api

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/backend ./backend

EXPOSE 4000
CMD ["npm", "run", "start:api"]
