FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Production packages only, and npm's download cache left out of the image (a smaller image starts faster).
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY db ./db
COPY public ./public
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
