# CPU-only extraction job for Azure Container Apps. Build from extraction-host/.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OCR_DEVICE=cpu HF_HOME=/opt/models/hf

WORKDIR /app
COPY requirements-job.txt .
RUN pip install --no-cache-dir -r requirements-job.txt

COPY extract_core.py job.py ./
COPY fixtures/scan.pdf /tmp/warm.pdf
# One scan and one image conversion pull every model the pipelines load, so the job needs no
# model download at run time.
RUN python -c "import extract_core as c; from PIL import Image; \
Image.new('RGB', (64, 64), 'white').save('/tmp/warm.png'); \
c.build_converter().convert('/tmp/warm.pdf'); c.build_converter().convert('/tmp/warm.png'); \
c.build_converter(force_ocr=True).convert('/tmp/warm.pdf')" \
 && rm /tmp/warm.pdf /tmp/warm.png \
 && chmod -R a+rX /opt/models "$(python -c 'import rapidocr, os; print(os.path.dirname(rapidocr.__file__))')"
ENV HF_HUB_OFFLINE=1

USER 1000
CMD ["python", "job.py"]
