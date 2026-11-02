FROM node:22-alpine AS admin-build
WORKDIR /app/admin
COPY admin/package.json admin/package-lock.json ./
RUN npm ci
COPY admin/ ./
RUN npm run build

FROM node:22-alpine AS server-dependencies
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/server
COPY --from=server-dependencies --chown=node:node /app/server/node_modules ./node_modules
COPY --chown=node:node server/package.json server/package-lock.json ./
COPY --chown=node:node server/src/ ./src/
COPY --chown=node:node server/scripts/ ./scripts/
COPY --chown=node:node server/sql/ ./sql/
COPY --from=admin-build --chown=node:node /app/admin/dist/ /app/admin/dist/
RUN mkdir -p /app/server/uploads && chown node:node /app/server/uploads
USER node
EXPOSE 4000
CMD ["node", "src/server.js"]
