#!/usr/bin/env bash

# Stockfish herunterladen
wget https://stockfishchess.org/files/stockfish_15.1_linux_x64_avx2.zip

# Entpacken
unzip stockfish_15.1_linux_x64_avx2.zip

# Umbenennen für einfachen Zugriff
mv stockfish*/stockfish* ./stockfish

# ausführbar machen
chmod +x stockfish