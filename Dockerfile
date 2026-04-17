FROM node:20-bookworm

WORKDIR /app

# System + Stockfish
RUN apt-get update \
    && apt-get install -y stockfish \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 10000

CMD ["node", "index.js"]