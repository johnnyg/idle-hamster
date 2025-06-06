UUID=$(shell jq -r .uuid metadata.json)
SCHEMA_NAME=$(shell jq -r '."settings-schema"' metadata.json)
BUNDLE_FILENAME=$(UUID).shell-extension.zip
SCHEMA_FILENAME=schemas/$(SCHEMA_NAME).gschema.xml

.PHONY: all pack install clean test-schema

all: dist/extension.js

node_modules: package.json
	@npm install

dist/extension.js dist/prefs.js: node_modules extension.ts prefs.ts
	@tsc

test-schema: $(SCHEMA_FILENAME)
	@glib-compile-schemas --strict --dry-run schemas

$(BUNDLE_FILENAME): metadata.json dist/extension.js dist/prefs.js $(SCHEMA_FILENAME) test-schema
	@gnome-extensions pack --extra-source=dist/extension.js --extra-source=dist/prefs.js --force

pack: $(BUNDLE_FILENAME)

install: $(BUNDLE_FILENAME)
	@gnome-extensions install --force $(BUNDLE_FILENAME)

clean:
	@rm -rf dist node_modules $(BUNDLE_FILENAME)
