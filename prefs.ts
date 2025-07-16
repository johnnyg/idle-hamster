import Gtk from "gi://Gtk";
import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import GLib from "gi://GLib";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import { gettext as _ } from "./gettext.js";

// Wrapper for `Gio.Settings.bind_with_mapping` to work around
// it not fully working in GJS, see: https://gitlab.gnome.org/GNOME/gjs/-/issues/397`
function bind_with_mapping<T extends GObject.Object, K extends keyof T>(
  settings: Gio.Settings,
  key: string,
  object: T,
  property: K,
  type: new () => T,
  flags: Gio.SettingsBindFlags | null,
  get_mapping?: (variant: GLib.Variant) => T[K] | null,
  set_mapping?: (
    value: T[K],
    variantType: GLib.VariantType
  ) => GLib.Variant | null
) {
  flags = flags ?? Gio.SettingsBindFlags.DEFAULT;
  if (flags == Gio.SettingsBindFlags.DEFAULT) {
    // Expand default so that we can split get and set
    flags = Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.SET;
  }
  // `Gio.Settings.bind_with_mapping` doesn't work in GJS as the value that is passed
  // as a first argument is expected to be passed by reference and our mapping function
  // is then supposed to write the mapped value to that reference however in GJS
  // the first argument is passed by value meaning that you always get the initialised value
  // as the first argument in your mapping function and no way to actually update the value.
  // We can work around this in GJS by just manually assigning the value to the `GObject.Object`
  // however the issue is that after our mapping function exits, the GLib code will then also update
  // that same property with the initialised value (0) so we need to pass in a dummy object so
  // that this last write doesn't override our update.
  const dummy = new type();
  // Of course manually updating the property here also triggers a false set event so we also need to
  // ignore that
  let ignoreSet: boolean = false;

  if (flags & Gio.SettingsBindFlags.GET && get_mapping != undefined) {
    settings!.bind_with_mapping(
      key,
      dummy,
      property as string,
      flags & ~Gio.SettingsBindFlags.SET,
      (_: K, variant: GLib.Variant): boolean => {
        const newProperty = get_mapping(variant);
        if (newProperty == null) {
          return false;
        }
        ignoreSet = true;
        object[property] = newProperty;
        return true;
      },
      null
    );
  }

  if (flags & Gio.SettingsBindFlags.SET && set_mapping != undefined) {
    settings!.bind_with_mapping(
      key,
      object,
      property as string,
      flags & ~Gio.SettingsBindFlags.GET,
      null,
      (value: T[K], variantType: GLib.VariantType): GLib.Variant | null => {
        if (ignoreSet) {
          ignoreSet = false;
          return null;
        }
        return set_mapping(value, variantType);
      }
    );
  }
}

export default class IdleHamsterPreferences extends ExtensionPreferences {
  _settings?: Gio.Settings;
  _sessionSettings?: Gio.Settings;
  _stopOnSuspendEnumToIndex?: Map<string, number>;
  _stopOnSuspendIndexToEnum?: string[];
  _stopOnSuspendEnumToLabel?: Map<string, string>;

  constructor(metadata: any) {
    super(metadata);
    this._settings = this.getSettings();
    this._sessionSettings = this.getSettings("org.gnome.desktop.session");
    const [stopOnSuspendRangeType, stopOnSuspendRangeValues] =
      this._settings!.settingsSchema.get_key("stop-on-suspend")
        .get_range()
        .recursiveUnpack();
    if (stopOnSuspendRangeType != "enum") {
      throw `Unexpected range value for stop-on-suspend: ${stopOnSuspendRangeType}`;
    }
    this._stopOnSuspendIndexToEnum = stopOnSuspendRangeValues;
    this._stopOnSuspendEnumToIndex = new Map(
      this._stopOnSuspendIndexToEnum!.map((choice: string, index: number) => [
        choice,
        index,
      ])
    );
    this._stopOnSuspendEnumToLabel = new Map([
      ["never", _("Never")],
      ["idle", _("If Idle")],
      ["always", _("Always")],
    ]);
    if (
      !this._stopOnSuspendIndexToEnum?.every((value) =>
        this._stopOnSuspendEnumToLabel?.has(value)
      )
    ) {
      throw `Mismatch between settings ${
        this._stopOnSuspendIndexToEnum
      } and prefs ${this._stopOnSuspendEnumToLabel.keys()}`;
    }
  }

  async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const page = new Adw.PreferencesPage({
      title: _("General"),
      iconName: "dialog-information-symbolic",
    });
    window.add(page);

    const idleGroup = new Adw.PreferencesGroup({
      title: _("Idle settings"),
      description: _("Configure how we define how long idle is"),
    });
    page.add(idleGroup);

    const idleDelay = new Adw.SpinRow({
      title: _("Idle duration"),
      subtitle: _("How many minutes before we stop tracking an activity"),
      adjustment: new Gtk.Adjustment({
        lower: 1,
        upper: 1000,
        stepIncrement: 1,
      }),
    });
    idleGroup.add(idleDelay);

    const useSessionIdleDelay = new Adw.SwitchRow({
      title: _("Use screen lock idle duration"),
      subtitle: _("Use the same idle time as the screen lock"),
    });
    idleGroup.add(useSessionIdleDelay);

    const otherStopEventsGroup = new Adw.PreferencesGroup({
      title: _("Other stop events"),
      description: _(
        "Configure whether we stop tracking based on other events"
      ),
    });
    page.add(otherStopEventsGroup);

    const stopOnLock = new Adw.SwitchRow({
      title: _("Stop tracking activity on screen lock"),
      subtitle: _("Stop tracking on screen lock regardless of idle time"),
    });
    otherStopEventsGroup.add(stopOnLock);

    const stopOnSuspend = new Adw.ComboRow({
      title: _("Stop tracking activity on suspend"),
      subtitle: _("Stop tracking when machine is suspended"),
      model: new Gtk.StringList({
        strings: this._stopOnSuspendIndexToEnum?.map(
          (choice: string) => this._stopOnSuspendEnumToLabel!.get(choice)!
        ),
      }),
    });
    otherStopEventsGroup.add(stopOnSuspend);

    const stopOnShutdown = new Adw.SwitchRow({
      title: _("Stop tracking activity on shutdown"),
      subtitle: _("Stop tracking when machine is shutdown"),
    });
    otherStopEventsGroup.add(stopOnShutdown);

    const notificationsGroup = new Adw.PreferencesGroup({
      title: _("Notifications"),
      description: _("Configure which notifications to show"),
    });
    page.add(notificationsGroup);

    const notifyOnStop = new Adw.SwitchRow({
      title: _("Notify when stop tracking an activity"),
      subtitle: _("Show a notification when we stop tracking activity"),
    });
    notificationsGroup.add(notifyOnStop);

    useSessionIdleDelay.bind_property(
      "active",
      idleDelay,
      "sensitive",
      GObject.BindingFlags.DEFAULT |
        GObject.BindingFlags.INVERT_BOOLEAN |
        GObject.BindingFlags.SYNC_CREATE
    );

    this._settings!.bind(
      "use-session-idle-delay",
      useSessionIdleDelay,
      "active",
      Gio.SettingsBindFlags.DEFAULT
    );

    bind_with_mapping(
      this._settings!,
      "idle-delay",
      idleDelay,
      "value",
      Adw.SpinRow,
      Gio.SettingsBindFlags.DEFAULT,
      (variant: GLib.Variant): number | null =>
        Math.floor(variant.get_uint16() / 60),
      (value: number, _: GLib.VariantType): GLib.Variant =>
        GLib.Variant.new_uint16(value * 60)
    );

    bind_with_mapping(
      this._sessionSettings!,
      "idle-delay",
      useSessionIdleDelay,
      "sensitive",
      Adw.SwitchRow,
      Gio.SettingsBindFlags.GET,
      (variant: GLib.Variant): boolean | null => variant.get_uint32() > 0
    );

    this._settings!.bind(
      "stop-on-lock",
      stopOnLock,
      "active",
      Gio.SettingsBindFlags.DEFAULT
    );

    const logger = this.getLogger();

    bind_with_mapping(
      this._settings!,
      "stop-on-suspend",
      stopOnSuspend,
      "selected",
      Adw.ComboRow,
      Gio.SettingsBindFlags.DEFAULT,
      (variant: GLib.Variant): number | null => {
        const [choice, _] = variant.get_string();
        const index = this._stopOnSuspendEnumToIndex!.get(choice)!;
        logger.log(`${choice} -> ${index}`);
        return index;
      },
      (index: number, _: GLib.VariantType): GLib.Variant => {
        const choice = GLib.Variant.new_string(
          this._stopOnSuspendIndexToEnum![index]
        );
        logger.log(`${index} -> ${choice.print(true)}`);
        return choice;
      }
    );
    this._settings!.bind(
      "stop-on-shutdown",
      stopOnShutdown,
      "active",
      Gio.SettingsBindFlags.DEFAULT
    );

    this._settings!.bind(
      "stop-on-shutdown",
      stopOnShutdown,
      "active",
      Gio.SettingsBindFlags.DEFAULT
    );

    this._settings!.bind(
      "notify-on-stop",
      notifyOnStop,
      "active",
      Gio.SettingsBindFlags.DEFAULT
    );

    useSessionIdleDelay.set_property(
      "active",
      this._settings!.get_boolean("use-session-idle-delay")
    );

    idleDelay.set_property(
      "sensitive",
      !this._settings!.get_boolean("use-session-idle-delay")
    );
  }
}
