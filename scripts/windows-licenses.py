import importlib.metadata
from pathlib import Path
import shutil
import sys

target = Path(sys.argv[1])
python_license = Path(sys.base_prefix) / 'LICENSE.txt'
if python_license.exists():
    shutil.copyfile(python_license, target / 'Python.txt')
for name in ['sounddevice', 'cffi', 'pycparser', 'pyinstaller']:
    distribution = importlib.metadata.distribution(name)
    for item in distribution.files or []:
        if any(part.lower().startswith(('license', 'copying')) for part in item.parts):
            source = Path(distribution.locate_file(item))
            if source.is_file():
                shutil.copyfile(source, target / (name + '-' + source.name))
