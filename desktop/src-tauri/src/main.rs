// Wrapper desktop do Log Viewer.
//
// Nao reimplementa nada do backend: sobe o MESMO app Flask (logviewer/,
// app.py) como um processo filho local, via desktop/run_server.py (waitress,
// multiplataforma), e abre uma janela nativa apontando pra ele — a mesma
// pagina que roda no navegador na versao web/Docker.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_PORT: u16 = 5057;

struct ServerProcess(Mutex<Option<Child>>);

/// Raiz do repositorio: desktop/src-tauri -> sobe dois niveis. So vale
/// enquanto rodamos direto do checkout (fase local, sem instalador ainda);
/// quando empacotarmos de verdade isso vira um caminho de recurso embutido.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

/// Acha um python utilizavel: preferindo o venv do projeto (onde Flask e
/// waitress ja estao instalados) e caindo para o python do sistema.
fn find_python(root: &PathBuf) -> PathBuf {
    let candidates = if cfg!(target_os = "windows") {
        vec![root.join(".venv").join("Scripts").join("python.exe")]
    } else {
        vec![root.join(".venv").join("bin").join("python3")]
    };
    for c in candidates {
        if c.exists() {
            return c;
        }
    }
    PathBuf::from(if cfg!(target_os = "windows") {
        "python"
    } else {
        "python3"
    })
}

/// Porta livre em 127.0.0.1: tenta a padrao primeiro (mais previsivel pra
/// quem esta olhando os logs), senao pede uma porta efemera ao SO.
fn pick_port() -> u16 {
    if TcpStream::connect(("127.0.0.1", DEFAULT_PORT)).is_err() {
        return DEFAULT_PORT;
    }
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(DEFAULT_PORT)
}

fn wait_until_up(port: u16) {
    for _ in 0..60 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    eprintln!("aviso: o backend nao respondeu em 127.0.0.1:{port} a tempo");
}

fn main() {
    let root = repo_root();
    let python = find_python(&root);
    let port = pick_port();

    let mut cmd = Command::new(&python);
    cmd.arg(root.join("desktop").join("run_server.py"))
        .current_dir(&root)
        .env("PORT", port.to_string())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    let child = cmd.spawn().unwrap_or_else(|e| {
        panic!(
            "Nao consegui iniciar o backend ({} {}): {e}",
            python.display(),
            root.join("desktop").join("run_server.py").display()
        )
    });

    wait_until_up(port);

    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(Some(child))))
        .setup(move |app| {
            let url = format!("http://127.0.0.1:{port}/");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("Log Viewer BSC")
                .inner_size(1400.0, 900.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Tauri")
        .run(|app_handle, event| {
            // Encerrar a janela nao pode deixar o processo Python orfao rodando.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<ServerProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}
