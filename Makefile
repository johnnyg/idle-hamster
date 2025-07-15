UUID := $(shell jq -r .uuid metadata.json)
SCHEMA_NAME := $(shell jq -r '."settings-schema"' metadata.json)
BUNDLE_FILENAME := $(UUID).shell-extension.zip
SCHEMA_FILENAME := schemas/$(SCHEMA_NAME).gschema.xml
TS_FILES := $(filter-out %.d.ts,$(wildcard *.ts))
JS_FILES := $(TS_FILES:%.ts=dist/%.js)
JS_FILENAMES := $(JS_FILES:dist/%.js=%.js)

.PHONY: all pack install clean test-schema test-nested

all: $(JS_FILES)

node_modules: package.json
	@npm install

$(JS_FILES): node_modules $(TS_FILES)
	@tsc

test-schema: $(SCHEMA_FILENAME)
	@glib-compile-schemas --strict --dry-run schemas

$(BUNDLE_FILENAME): metadata.json $(JS_FILES) $(SCHEMA_FILENAME) test-schema
	@gnome-extensions pack $(JS_FILES:%=--extra-source=%) --force

pack: $(BUNDLE_FILENAME)

install: $(BUNDLE_FILENAME)
	@gnome-extensions install --force $(BUNDLE_FILENAME)

clean:
	@rm -rf dist node_modules $(BUNDLE_FILENAME)

test-nested: install
	@env G_MESSAGES_DEBUG="GNOME Shell" MUTTER_DEBUG_DUMMY_MODE_SPECS=2160x1350 SHELL_DEBUG=all WAYLAND_DISPLAY=wayland-1 \
		dbus-run-session -- gnome-shell --wayland-display=wayland-1 --nested --wayland
