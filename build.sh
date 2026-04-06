#!/usr/bin/env bash

# Richtiger Download-Link (WICHTIG)
wget https://github.com/official-stockfish/Stockfish/releases/latest/download/stockfish-ubuntu-x86-64-avx2.tar

# Entpacken
tar -xvf stockfish-ubuntu-x86-64-avx2.tar

# Datei umbenennen
mv stockfish/stockfish-ubuntu-x86-64-avx2 stockfish

# ausführbar machen
chmod +x stockfish