FROM node:20-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y stockfish

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "index.js"]