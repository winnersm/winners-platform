FROM python:3.12-slim

# ffmpeg es obligatorio, no opcional: cada vídeo se limpia de metadatos antes de
# subirlo a la cuenta destino. Sin él los vídeos llegarían a Meta con el
# software de edición, las fechas y a veces el nombre del proyecto.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/

EXPOSE 8760

# Sin etiquetas de Traefik: el motor vive en la red interna y solo lo alcanza
# la app, que además manda un token compartido en cada petición.
CMD ["python", "-m", "src.api"]
