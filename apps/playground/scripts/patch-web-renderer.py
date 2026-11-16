"""Compatibility entry for the engine-owned Web patch implementation."""
from pathlib import Path
import runpy

_source = Path(__file__).resolve().parents[3] / 'impl/web/patches/patch-web-renderer.py'
_implementation = runpy.run_path(str(_source))
patched = _implementation['patched']
patched_backbuffer = _implementation['patched_backbuffer']

if __name__ == '__main__':
    runpy.run_path(str(_source), run_name='__main__')
