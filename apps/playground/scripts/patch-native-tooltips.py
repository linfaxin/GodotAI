"""Keep Viewport-owned tooltips private, like other native Control helpers."""
from pathlib import Path
import sys
import json

def patched(source):
    before = 'tooltip_owner->add_child(gui.tooltip_popup);'
    after = 'tooltip_owner->add_child(gui.tooltip_popup, false, Node::INTERNAL_MODE_BACK); // GODOTAI_PRIVATE_TOOLTIP_V1'
    if after in source and source.count(after) == 1 and before not in source:
        return source
    if source.count(before) != 1 or 'GODOTAI_PRIVATE_TOOLTIP_V1' in source:
        raise ValueError('Unsupported native tooltip ownership layout')
    return source.replace(before, after)

if __name__ == '__main__':
    path = Path(sys.argv[1]) / 'scene/main/viewport.cpp'
    source = path.read_text()
    result = patched(source)
    if '--json' in sys.argv:
        print(json.dumps({'scene/main/viewport.cpp': result}))
    elif result != source:
        path.write_text(result)
