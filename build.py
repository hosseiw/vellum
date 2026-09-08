#!/usr/bin/env python3
"""Bundle the dependency-free ES modules into a single portable HTML document."""
import re
from pathlib import Path
ROOT = Path(__file__).resolve().parent
source_file = (ROOT / 'editor.html') if (ROOT / 'editor.html').exists() else (ROOT / 'index.html')
html = source_file.read_text(encoding="utf-8")
css = (ROOT / 'styles.css').read_text(encoding="utf-8")
modules = ['document.js', 'renderer.js', 'icons.js', 'svg.js', 'storage.js', 'app.js']
code = []
for name in modules:
    text = (ROOT / 'src' / name).read_text(encoding="utf-8")
    text = re.sub(r'^import .*?;\s*$', '', text, flags=re.M)
    text = re.sub(r'^export\s+', '', text, flags=re.M)
    code.append(f'\n// ===== {name} =====\n{text}')
html = html.replace('<link rel="stylesheet" href="styles.css">', f'<style>{css}</style>')
html = html.replace('<script type="module" src="src/app.js"></script>', '<script type="module">\n' + '\n'.join(code).replace('</script', '<\\/script') + '\n</script>')
(ROOT / 'Vellum.html').write_text(html, encoding="utf-8")
print(f'Built Vellum.html: {len(html.encode()):,} bytes')
