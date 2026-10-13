FROM python:3.12-slim

WORKDIR /app

# El contexto de build es este directorio, así que las rutas son relativas a él.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src

# Los logs van a un volumen: sobreviven a los despliegues.
RUN mkdir -p /app/logs

CMD ["python", "-m", "src.main"]
