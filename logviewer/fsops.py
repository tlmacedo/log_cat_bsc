import os

TEXT_EXT_HINTS = {
    ".log", ".txt", ".xml", ".csv", ".config", ".json", ".md", ".ini",
    ".yaml", ".yml", ".drpt", ".dlf", ".conf", ".p",
}
BINARY_EXT_HINTS = {
    ".dat", ".zip", ".gz", ".tar", ".mdb", ".db", ".shm", ".wal",
    ".sqlite", ".bin", ".jpg", ".jpeg", ".png",
}

MAX_TREE_ENTRIES = 5000


class PathError(ValueError):
    pass


def resolve_root(root):
    if not root:
        raise PathError("Parametro 'root' e obrigatorio.")
    real_root = os.path.realpath(root)
    if not os.path.exists(real_root):
        raise PathError(f"Pasta nao encontrada: {root}")
    if not os.path.isdir(real_root):
        raise PathError(f"Nao e um diretorio: {root}")
    if not os.access(real_root, os.R_OK):
        raise PathError(f"Sem permissao de leitura: {root}")
    return real_root


def resolve_within_root(root, rel_path):
    """Resolve rel_path relative to root, rejecting any escape via '..' or symlinks."""
    real_root = resolve_root(root)
    candidate = os.path.realpath(os.path.join(real_root, rel_path or ""))
    if candidate != real_root and not candidate.startswith(real_root + os.sep):
        raise PathError("Caminho fora da pasta raiz informada.")
    if not os.path.exists(candidate):
        raise PathError(f"Arquivo nao encontrado: {rel_path}")
    return candidate


def guess_ext_is_text(ext):
    ext = ext.lower()
    if ext in TEXT_EXT_HINTS:
        return True
    if ext in BINARY_EXT_HINTS:
        return False
    return None  # unknown, needs content sniff to be sure


def sniff_is_text(path, sample_size=4096):
    """Peek at the first bytes to guess binary vs text, without reading the whole file."""
    try:
        with open(path, "rb") as f:
            sample = f.read(sample_size)
    except OSError:
        return False
    if not sample:
        return True  # empty file, treat as text
    if b"\x00" in sample:
        return False
    try:
        sample.decode("utf-8")
        return True
    except UnicodeDecodeError:
        pass
    try:
        sample.decode("latin-1")
        return True
    except UnicodeDecodeError:
        return False


def browse(path=None):
    """Subpastas de um caminho, para o seletor de pasta da interface.

    O navegador nunca revela o caminho real de uma pasta escolhida pelo
    usuario, entao quem navega e o servidor: e ele que precisa enxergar a pasta
    para ler os logs. Dentro do container isso mostra exatamente o que foi
    montado, que e o que importa."""
    path = os.path.realpath(os.path.expanduser(path or os.path.expanduser("~")))
    if not os.path.isdir(path):
        raise PathError(f"Pasta nao encontrada: {path}")
    if not os.access(path, os.R_OK):
        raise PathError(f"Sem permissao de leitura: {path}")

    dirs, files = [], 0
    try:
        with os.scandir(path) as it:
            for entry in it:
                if entry.name.startswith("."):
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        dirs.append(entry.name)
                    else:
                        files += 1
                except OSError:
                    continue
    except OSError as e:
        raise PathError(f"Nao consegui listar {path}: {e}")

    dirs.sort(key=str.lower)
    parent = os.path.dirname(path)
    return {
        "path": path,
        "parent": parent if parent != path else None,
        "dirs": [{"name": d, "path": os.path.join(path, d)} for d in dirs[:2000]],
        "files": files,
        "truncated": len(dirs) > 2000,
    }


def list_tree(root):
    real_root = resolve_root(root)
    entries = []
    truncated = False
    visited_dirs = set()

    for dirpath, dirnames, filenames in os.walk(real_root, followlinks=False):
        real_dirpath = os.path.realpath(dirpath)
        if real_dirpath in visited_dirs:
            dirnames[:] = []
            continue
        visited_dirs.add(real_dirpath)

        dirnames.sort()
        filenames.sort()

        for name in dirnames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, real_root)
            try:
                st = os.lstat(full)
            except OSError:
                continue
            entries.append({
                "path": rel,
                "name": name,
                "is_dir": True,
                "is_symlink": os.path.islink(full),
                "size": None,
                "mtime": st.st_mtime,
                "ext": None,
                "likely_text": None,
            })
            if len(entries) >= MAX_TREE_ENTRIES:
                truncated = True
                break

        if truncated:
            break

        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, real_root)
            try:
                st = os.lstat(full)
            except OSError:
                continue
            ext = os.path.splitext(name)[1]
            entries.append({
                "path": rel,
                "name": name,
                "is_dir": False,
                "is_symlink": os.path.islink(full),
                "size": st.st_size,
                "mtime": st.st_mtime,
                "ext": ext,
                "likely_text": guess_ext_is_text(ext),
            })
            if len(entries) >= MAX_TREE_ENTRIES:
                truncated = True
                break

        if truncated:
            break

    return {
        "root": real_root,
        "entries": entries,
        "truncated": truncated,
        "max_entries": MAX_TREE_ENTRIES,
    }
