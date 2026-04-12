FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Stockfish ausführbar machen (WICHTIG)
RUN chmod +x ./stockfish/stockfish

EXPOSE 10000

CMD ["node", "index.js"]