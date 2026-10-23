FROM node:22-bookworm-slim AS build
ENV MONGOMS_DISABLE_POSTINSTALL=1
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production SERVE_CLIENT=true PORT=8080
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/client/dist /app/client/dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
