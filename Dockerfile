FROM node:20-bookworm

WORKDIR /app

RUN echo "🔥 STEP 1 START" && \
    apt-get update && \
    echo "🔥 AFTER UPDATE" && \
    apt-get install -y stockfish && \
    echo "🔥 AFTER INSTALL" && \
    dpkg -L stockfish || true && \
    which stockfish || true && \
    ls -R /usr/games || true

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "index.js"]