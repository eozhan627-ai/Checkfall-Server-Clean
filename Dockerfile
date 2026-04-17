FROM node:20-bookworm

WORKDIR /app
RUN apt-get update && apt-get install -y stockfish \
    && stockfish --version \
    && which stockfish || true \
    && ls -l /usr/games || true
COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 10000

CMD ["node", "index.js"]