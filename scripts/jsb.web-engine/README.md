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

See `scripts/release/README.web.md` in the source repository for the build,
verification and publication commands. This package does not execute Node.js in
the browser and does not use WebContainers.
