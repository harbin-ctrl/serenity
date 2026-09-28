#!/usr/bin/env python3
"""Build the offline, self-contained HTML from its readable source files."""
from pathlib import Path
root = Path(__file__).resolve().parent
html = (root / 'index.template.html').read_text()
for token, filename in [('CSS','style.css'), ('MODEL','model.js'), ('APP','app.js')]:
    html = html.replace(f'/*__{token}__*/', (root / filename).read_text())
(root / 'index.html').write_text(html)
print(root / 'index.html')
