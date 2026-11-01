FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY build.mjs ./
COPY src ./src
COPY public ./public

RUN npm run build && npm prune --omit=dev


FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=8080

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server

EXPOSE 8080
USER node
CMD ["node", "server/index.mjs"]
