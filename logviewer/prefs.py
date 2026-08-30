"""Preferencias que precisam ser as mesmas em toda distribuicao (web, Mac,
Windows) porque todas conversam com o MESMO backend/processo Python — ao
contrario do localStorage do navegador, que fica preso a cada origem/webview
e por isso os filtros salvos apareciam diferentes entre a versao web e a
versao desktop mesmo apontando pro mesmo servidor.

Guardado em arquivos JSON simples: nao ha usuarios/contas no app, e o volume
de dados (filtros, atalhos de pasta/arquivo, uma lista de caminhos escondidos)
e pequeno.
"""

import json
import os
import tempfile

CONFIG_ROOT = os.environ.get("CONFIG_ROOT") or os.path.expanduser("~/.logviewer")
SAVED_FILTERS_PATH = os.path.join(CONFIG_ROOT, "saved_filters.json")
PROJECT_ENTRIES_PATH = os.path.join(CONFIG_ROOT, "project_entries.json")
HIDDEN_PATHS_PATH = os.path.join(CONFIG_ROOT, "hidden_paths.json")


def _load_list(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []
    return data if isinstance(data, list) else []


def _save_list(path, data):
    if not isinstance(data, list):
        raise ValueError("precisa ser uma lista")
    os.makedirs(CONFIG_ROOT, exist_ok=True)
    # Escrita atomica: um crash no meio do write nao pode deixar o arquivo
    # corrompido e derrubar tudo que estava salvo.
    fd, tmp_path = tempfile.mkstemp(dir=CONFIG_ROOT, prefix=".pref-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def load_saved_filters():
    return _load_list(SAVED_FILTERS_PATH)


def save_saved_filters(filters):
    _save_list(SAVED_FILTERS_PATH, filters)


def load_project_entries():
    """Pastas/arquivos extras fixados na barra lateral, cada um sua propria
    raiz (podem estar em qualquer lugar do disco, fora da pasta carregada)."""
    return _load_list(PROJECT_ENTRIES_PATH)


def save_project_entries(entries):
    _save_list(PROJECT_ENTRIES_PATH, entries)


def load_hidden_paths():
    """Caminhos absolutos removidos da barra lateral (arquivo ou pasta,
    dentro da raiz principal ou de qualquer entrada extra) sem apagar nada do
    disco — so deixam de aparecer na arvore."""
    return _load_list(HIDDEN_PATHS_PATH)


def save_hidden_paths(paths):
    _save_list(HIDDEN_PATHS_PATH, paths)
