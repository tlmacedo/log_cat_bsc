# Log Viewer

Visualizador e analisador de logs do Android (logcat, bugreport, dumpstate),
feito para arquivos grandes: abre despejos de centenas de MB, busca no arquivo
inteiro e extrai as informacoes do aparelho.

## Rodando

Requisito unico: **Docker Desktop** instalado e aberto.

```bash
git clone https://github.com/tlmacedo/log_cat_bsc.git
cd log_cat_bsc
```

**macOS e Linux**

```bash
./scripts/start-mac.sh                 # usa a pasta log/ do repositorio
./scripts/start-mac.sh /caminho/logs   # ou aponte para a sua pasta
```

**Windows (PowerShell)**

```powershell
.\scripts\start-windows.ps1
.\scripts\start-windows.ps1 C:\caminho\logs
```

O script confere o Docker, prepara as pastas, liga o servidor adb (se houver),
constroi a imagem, sobe o container e abre o navegador em
<http://127.0.0.1:5057>.

Para parar: `docker compose down` (ou `./scripts/stop.sh`).

### Onde ficam os arquivos

| No seu computador | Dentro do app | Observacao |
|---|---|---|
| a pasta que voce passou ao script | `/logs` | montada **somente leitura** |
| `capturas/` no repositorio | `/capturas` | capturas de aparelhos USB |

Os caminhos aparecem como `/logs/...` na interface porque e assim que o
container os enxerga. O conteudo e o da sua pasta.

### Como o app trata os seus logs

O app **aponta para a sua pasta e le no lugar**. Nenhum arquivo de log e
copiado, movido ou apagado: eles continuam sendo seus, onde sempre estiveram, e
a montagem e somente leitura. Nao ha nada para o app limpar depois.

A consequencia e que ele so enxerga o que foi montado na inicializacao. Para
analisar outra pasta, rode o script de novo apontando para ela:

```bash
./scripts/start-mac.sh /outro/caminho/logs
```

A unica pasta que o app mantem por conta propria e `capturas/`, com o que ele
mesmo baixou dos aparelhos USB. Essa voce pode apagar quando quiser.

### Aparelhos USB

O Docker Desktop no macOS e no Windows roda numa maquina virtual que **nao
enxerga as portas USB**. Por isso o container nao fala com o aparelho
diretamente: ele usa o **servidor adb da sua maquina**, e o script cuida de
liga-lo.

Para a aba de aparelhos funcionar:

1. Tenha as *platform-tools* do Android instaladas (o `adb` no PATH).
2. Ligue o cabo e autorize a depuracao USB na tela do aparelho.
3. Rode o script — ele mostra quantos aparelhos encontrou.

Sem `adb` o app sobe normalmente; so a aba de aparelhos fica indisponivel, e o
script avisa.

## O que o app faz

- **Abre arquivos grandes** por paginas de ate 50.000 linhas, com salto direto
  para qualquer linha e uma linha do tempo do arquivo inteiro marcando crashes,
  ANRs, tombstones, watchdog e falta de memoria.
- **Reconhece nove formatos de logcat** (threadtime com e sem UID, time, brief,
  tag, process, thread, long e o "save log" do DDMS) e mostra as colunas
  separadas, com cor por nivel e largura ajustavel.
- **Busca no arquivo inteiro**, nao so na pagina carregada. Cada pesquisa vira
  uma secao na janela de resultados, com as palavras coloridas.
  - `created for` procura a frase, com o espaco
  - `created|for` aceita uma ou outra
  - `created&for` exige as duas na mesma linha
  - `tag:` `pid:` `tid:` `uid:` `level:` restringem o campo; `pid:sbrowser`
    resolve o nome do processo para o PID de verdade
- **Filtros salvos** com varios nos: cada no cruza TAG, PID, TID, nivel e
  palavras-chave, e os nos se somam. Podem ficar varios ligados ao mesmo tempo.
- **Aba Aparelho** com modelo, build, kernel, CPU, memoria, bateria, telefonia
  e o mapa PID -> processo extraidos do proprio log.
- **Captura de aparelhos USB**: despeja os buffers de logcat e as propriedades
  numa pasta por aparelho, nomeada com modelo e serial.
- Destaques de palavra com navegacao (F3), marcadores, exportacao, sessao
  salva, glossario de siglas e temas claro e escuro.

## Rodando sem Docker

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 app.py            # http://127.0.0.1:5057
```

Variaveis reconhecidas: `PORT`, `LOG_ROOT` (pasta inicial), `CAPTURE_ROOT`
(destino das capturas), `ADB_HOST` e `ADB_PORT` (servidor adb remoto).
