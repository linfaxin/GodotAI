"""Regenerate the small CJK feature-test font from the pinned system Noto font.

Requires fonttools. Pass a source NotoSansCJK-Regular.ttc as argv[1].
The source font copyright and OFL are preserved in Noto-LICENSE.txt.
"""
from pathlib import Path
import hashlib
import sys
from fontTools.ttLib import TTFont
from fontTools import subset

source = Path(sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
expected = 'b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a'
if hashlib.sha256(source.read_bytes()).hexdigest() != expected:
    raise SystemExit('Unexpected source font; review provenance before regenerating the fixture')
font = TTFont(source, fontNumber=0, recalcTimestamp=False)
options = subset.Options()
options.recalc_timestamp = False
options.name_IDs = ['*']
subsetter = subset.Subsetter(options=options)
subsetter.populate(text='中文测试，开始输入第一行！' + ''.join(chr(i) for i in range(32, 127)))
subsetter.subset(font)
for record in font['name'].names:
    if record.nameID in (1, 2, 3, 4, 6, 16, 17):
        value = 'Regular' if record.nameID in (2, 17) else 'GodotJSFeatureTest' if record.nameID == 6 else 'GodotJS Feature Test'
        record.string = value.encode(record.getEncoding())
if 'CFF ' in font:
    cff = font['CFF '].cff
    cff.fontNames = ['GodotJSFeatureTest']
    top = cff.topDictIndex[0]
    top.FamilyName = 'GodotJS Feature Test'
    top.FullName = 'GodotJS Feature Test Regular'
    if hasattr(top, 'FDArray'):
        for index, dictionary in enumerate(top.FDArray):
            if hasattr(dictionary, 'FontName'):
                dictionary.FontName = 'GodotJSFeatureTest-FD' + str(index)
font.save(Path(__file__).with_name('test-cjk.otf'))
