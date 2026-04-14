FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Stockfish installieren im Container
RUN apt-get update && apt-get install -y stockfish 

EXPOSE 10000

CMD ["node", "index.js"]