FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY build.mjs ./
COPY src ./src
COPY public ./public

RUN npm run build


FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
