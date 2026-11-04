# Pin to a digest with scripts/pin-base-image.sh (a tag moves; a digest never does). deploy.sh warns while unpinned.
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Production packages only, and npm's download cache left out of the image (a smaller image starts faster).
# Then the parts of the scanned-document (OCR) add-on this server never uses are deleted (test/slim.test.js lists them
# and still reads a scanned PDF without them):
#   - the drawing library built for Alpine Linux (musl); this image is Debian, so only the glibc build is loaded
#   - the larger English language data (src/lib/doctext.js loads 4.0.0_best_int only)
#   - the OCR engine builds for web browsers (*.wasm.js) and the older non-LSTM engine (doctext.js asks for LSTM)
# --ignore-scripts: no package's install script runs in the build (the only one, tesseract.js's, prints a donation note).
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
 && rm -rf node_modules/@napi-rs/canvas-linux-x64-musl \
           node_modules/@tesseract.js-data/eng/4.0.0 \
           node_modules/tesseract.js-core/*.wasm.js \
           node_modules/tesseract.js-core/tesseract-core.js node_modules/tesseract.js-core/tesseract-core.wasm \
           node_modules/tesseract.js-core/tesseract-core-simd.js node_modules/tesseract.js-core/tesseract-core-simd.wasm \
           node_modules/tesseract.js-core/tesseract-core-relaxedsimd.js node_modules/tesseract.js-core/tesseract-core-relaxedsimd.wasm
COPY src ./src
COPY db ./db
COPY public ./public
# Our own copy of the US ski areas for demos (made by scripts/ski-areas-build.js; the demo page falls back without it)
COPY data ./data
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
