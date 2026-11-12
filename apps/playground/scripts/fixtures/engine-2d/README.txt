Real Web feature fixture

features.cjs runs directly inside the actual GodotJS engine. It creates native
physics bodies, a NavigationPolygon, a rendered TileMapLayer, a Label, a Button
and a looping WAV stream. The browser driver measures actual viewport pixels,
pointer input and AudioWorklet samples, and checks native/audio cleanup.
Browser console errors are recorded separately from page exceptions; either
kind fails acceptance, including WebGL validation errors without JS exceptions.

The actual native Button press starts the first playback after the browser
gesture. A native monotonic clock gives playback 2 seconds, then observes a
1.5 second stop and a 2 second restart. The browser must observe nonzero real
samples for both playback phases. The analyser branch connects through a zero
gain to the real destination so Firefox continuously processes it; the native
audible route stays intact. Complete stopped samples are recorded every 25 ms.
Acceptance requires a tail no longer than 300 ms, followed by at least 500 ms
continuous silence below 0.001, with no observation gap over 100 ms. Native
playing flags alone cannot pass the audio checks.

basic-text.cjs additionally checks the active text interface, mixed horizontal
Chinese/Latin text and punctuation, rich text, wrapping and editable controls.
Independent Chinese-only Label/RichTextLabel regions must each render pixels;
all sampled controls must remain fully inside the viewport. Latin glyphs cannot
satisfy the Chinese pixel checks.
browser-basic-text-test.mjs drives native LineEdit/TextEdit focus, selection,
Chinese composition commits, ASCII typing, newlines and caret positions using
real browser input and Chromium CDP composition events. It does not validate
an operating-system IME candidate window or complex-language layout.

The small test-cjk.otf is a renamed, subset derivative of the Noto Sans CJK font
from Debian fonts-noto-cjk. See Noto-LICENSE.txt for copyright and the SIL Open
Font License. The original font checksum and regeneration steps are pinned in
make-test-font.py. The test font is named GodotJS Feature Test; it includes only
the fixed Chinese text and basic ASCII used by these fixtures. It is a test asset, not a general-purpose
production Chinese font. FontTools is needed only to regenerate it.
