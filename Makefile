UUID=$(shell jq -r .uuid metadata.json)
SCHEMA_NAME=$(shell jq -r '."settings-schema"' metadata.json)
BUNDLE_FILENAME=$(UUID).shell-extension.zip
SCHEMA_FILENAME=schemas/$(SCHEMA_NAME).gschema.xml

.PHONY: all pack install clean test-schema test-nested

all: dist/extension.js

node_modules: package.json
	@npm install

dist/extension.js dist/prefs.js dist/signals.js: node_modules extension.ts prefs.ts signals.ts
	@tsc

test-schema: $(SCHEMA_FILENAME)
	@glib-compile-schemas --strict --dry-run schemas

$(BUNDLE_FILENAME): metadata.json dist/extension.js dist/prefs.js dist/signals.js $(SCHEMA_FILENAME) test-schema
	@gnome-extensions pack --extra-source=dist/extension.js --extra-source=dist/prefs.js --extra-source=dist/signals.js --force

pack: $(BUNDLE_FILENAME)

install: $(BUNDLE_FILENAME)
	@gnome-extensions install --force $(BUNDLE_FILENAME)

clean:
	@rm -rf dist node_modules $(BUNDLE_FILENAME)

test-nested: install
	@env G_MESSAGES_DEBUG="GNOME Shell" MUTTER_DEBUG_DUMMY_MODE_SPECS=2160x1350 SHELL_DEBUG=all WAYLAND_DISPLAY=wayland-1 \
		dbus-run-session -- gnome-shell --wayland-display=wayland-1 --nested --wayland
