"""Entrada usada pelo app desktop (Tauri) para subir o mesmo backend Flask.

O container Docker sobe via gunicorn (so Unix); aqui usamos waitress, que e
puro Python e roda igual em macOS e Windows. A logica do app (logviewer/,
app.py) e exatamente a mesma dos dois lados — isto e so o "como" servir.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from waitress import serve

from app import app

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5057))
    # So localhost: o processo e um filho do app desktop, nao um servico de rede.
    serve(app, host="127.0.0.1", port=port, threads=8)
