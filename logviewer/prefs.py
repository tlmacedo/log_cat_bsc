"""Preferencias que precisam ser as mesmas em toda distribuicao (web, Mac,
Windows) porque todas conversam com o MESMO backend/processo Python — ao
contrario do localStorage do navegador, que fica preso a cada origem/webview
e por isso os filtros salvos apareciam diferentes entre a versao web e a
versao desktop mesmo apontando pro mesmo servidor.

Guardado num arquivo JSON simples: nao ha usuarios/contas no app, e o volume
de dados (uma lista de filtros) e pequeno.
"""

import json
import os
import tempfile

CONFIG_ROOT = os.environ.get("CONFIG_ROOT") or os.path.expanduser("~/.logviewer")
SAVED_FILTERS_PATH = os.path.join(CONFIG_ROOT, "saved_filters.json")


def load_saved_filters():
    try:
        with open(SAVED_FILTERS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []
    return data if isinstance(data, list) else []


def save_saved_filters(filters):
    if not isinstance(filters, list):
        raise ValueError("filters precisa ser uma lista")
    os.makedirs(CONFIG_ROOT, exist_ok=True)
    # Escrita atomica: um crash no meio do write nao pode deixar o arquivo
    # corrompido e derrubar todos os filtros salvos.
    fd, tmp_path = tempfile.mkstemp(dir=CONFIG_ROOT, prefix=".saved_filters-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(filters, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, SAVED_FILTERS_PATH)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
