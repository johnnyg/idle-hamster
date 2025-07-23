UUID := $(shell jq -r .uuid metadata.json)
SCHEMA_NAME := $(shell jq -r '."settings-schema"' metadata.json)
GETTEXT_DOMAIN := $(shell jq -r '."gettext-domain"' metadata.json)
BUNDLE_FILENAME := $(UUID).shell-extension.zip
SCHEMA_FILENAME := schemas/$(SCHEMA_NAME).gschema.xml
TRANSLATIONS_FILENAME=po/$(GETTEXT_DOMAIN).pot
TS_FILES := $(filter-out %.d.ts,$(wildcard *.ts))
JS_FILES := $(TS_FILES:%.ts=dist/%.js)

.PHONY: all deps pack install clean test-schema test-nested translations

all: $(JS_FILES)

node_modules: package.json
	@# no need to audit here because we will always audit (even if node_modules exists)
	@npm install --no-audit

deps: node_modules
	@npm audit

$(JS_FILES): deps $(TS_FILES)
	@tsc

test-schema: $(SCHEMA_FILENAME)
	@glib-compile-schemas --strict --dry-run schemas

$(BUNDLE_FILENAME): metadata.json $(JS_FILES) $(SCHEMA_FILENAME) po/*.po test-schema
	@gnome-extensions pack $(JS_FILES:%=--extra-source=%) --force

pack: $(BUNDLE_FILENAME)

$(TRANSLATIONS_FILENAME): $(JS_FILES)
	@xgettext --from-code=UTF-8 --output=$(TRANSLATIONS_FILENAME) --tag=_:javascript-gnome-format \
		--directory=dist $(JS_FILES:dist/%.js=%.js) \
		$(JS_FILES:%=--generated=%) \
		$(TS_FILES:%=--reference=%)

translations: $(TRANSLATIONS_FILENAME)

install: $(BUNDLE_FILENAME)
	@gnome-extensions install --force $(BUNDLE_FILENAME)

clean:
	@rm -rf dist node_modules $(BUNDLE_FILENAME)

test-nested: install
	@env G_MESSAGES_DEBUG="GNOME Shell" MUTTER_DEBUG_DUMMY_MODE_SPECS=2160x1350 SHELL_DEBUG=all WAYLAND_DISPLAY=wayland-1 \
		dbus-run-session -- gnome-shell --wayland-display=wayland-1 --nested --wayland
