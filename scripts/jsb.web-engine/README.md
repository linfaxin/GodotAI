# GodotJS browser release assets

This package is assembled by `scripts/release/build-web-release.mjs`, not by
install-time scripts. Its `release.json` binds the actual engine, SDK, declaration
files and compiler bytes to an immutable SHA-256 identity. Asset paths are relative
to that descriptor; clients can load an exact npm version through jsDelivr.

Development artifacts may use an older local template and are explicitly
uncertified. Official publication additionally requires a successful source
build from identified Godot and GodotJS commits, matching browser validation,
external npm-pack verification, and a working npm identity. These are separate
from the optional audio/physics/browser capabilities recorded in the release.

Releases advertising `game-2d-v1` combine the existing 17 UI, media and 2D
physics hosts. Select that profile in the browser project's configuration to
use PNG/JPEG textures, checked collision shapes and React HUDs together. The
three older profiles retain their original boundaries. Certification for this
profile requires explicit production/development combination coverage in
Chromium, Firefox and Linux Playwright WebKit, plus Chromium production
lifecycle evidence and the three legacy-profile regressions. Each check binds
its profile, SDK mode, browser version and source report; the descriptor records
the actual scope. Audio remains outside this profile.

See `scripts/release/README.web.md` in the source repository for the build,
verification and publication commands. This package does not execute Node.js in
the browser and does not use WebContainers.
