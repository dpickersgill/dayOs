FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Production packages only, and npm's download cache left out of the image (a smaller image starts faster).
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY db ./db
COPY public ./public
# Our own copy of the US ski areas for demos (made by scripts/ski-areas-build.js; the demo page falls back without it)
COPY data ./data
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
