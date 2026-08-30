# Imagem da aplicacao. O adb instalado aqui e apenas o CLIENTE: quem enxerga a
# porta USB e o servidor adb da maquina do usuario, porque o Docker Desktop no
# Mac e no Windows roda numa VM sem acesso ao USB. Os scripts de inicializacao
# apontam ADB_HOST para o host.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends adb \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# As dependencias vem antes do codigo para que editar o app nao refaca a
# instalacao de pacotes a cada build.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY app.py ./
COPY logviewer/ ./logviewer/
COPY static/ ./static/

ENV PORT=5057 \
    LOG_ROOT=/logs \
    CAPTURE_ROOT=/capturas \
    PYTHONUNBUFFERED=1

RUN mkdir -p /logs /capturas
EXPOSE 5057

# Um worker so, com varias threads: os caches de varredura (linha do tempo,
# mapa de processos, indices de filtro) vivem no processo, e mais de um worker
# faria cada um varrer o arquivo por conta.
CMD ["sh", "-c", "gunicorn --workers 1 --threads 8 --timeout 1800 --bind 0.0.0.0:${PORT} app:app"]
