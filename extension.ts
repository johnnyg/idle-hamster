/* extension.ts
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from "gi://Gio";
import GLib from "gi://GLib";

import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";

Gio._promisify(Gio.DBusProxy, "new_for_bus");
Gio._promisify(Gio.DBusProxy.prototype, "call");

const IDLE_DELAY_OFFSET_SEC = 12; // 10s to blank

// Alias `Gio.DBusProxy.new_for_bus` because `Gio._promisify` confuses typescript
type GioDBusProxyNewForBus = (
  bus_type: Gio.BusType,
  flags: Gio.DBusProxyFlags,
  info: Gio.DBusInterfaceInfo | null,
  name: string,
  object_path: string,
  interface_name: string,
  cancellable?: Gio.Cancellable | null
) => Promise<Gio.DBusProxy>;

function toTimeString(sec: number): string {
  return `${Math.floor(sec / 60)} min ${Math.floor(sec % 60)} sec`;
}

export default class IdleHamsterExtension extends Extension {
  _hamsterProxy?: Gio.DBusProxy;
  _idleMonitorProxy?: Gio.DBusProxy;
  _settings?: Map<string, Gio.Settings>;
  _settingsHandlerIds?: Map<string, Map<string, number>>;
  _watchFiredHandlerId?: number;
  _watchId?: number;

  async enable(): Promise<void> {
    const logger = this.getLogger();
    logger.log("enabled");
    this._hamsterProxy = await (
      Gio.DBusProxy.new_for_bus as GioDBusProxyNewForBus
    )(
      Gio.BusType.SESSION,
      Gio.DBusProxyFlags.NONE,
      null,
      "org.gnome.Hamster",
      "/org/gnome/Hamster",
      "org.gnome.Hamster",
      null
    );
    this._idleMonitorProxy = await (
      Gio.DBusProxy.new_for_bus as GioDBusProxyNewForBus
    )(
      Gio.BusType.SESSION,
      Gio.DBusProxyFlags.NONE,
      null,
      "org.gnome.Mutter.IdleMonitor",
      "/org/gnome/Mutter/IdleMonitor/Core",
      "org.gnome.Mutter.IdleMonitor",
      null
    );
    this._watchFiredHandlerId = this._idleMonitorProxy!.connect(
      "g-signal::WatchFired",
      async (
        source: Gio.DBusProxy,
        _senderName: string | null,
        _signalName: string,
        _parameters: GLib.Variant
      ) => {
        const idleTime = (
          await source.call(
            "GetIdletime",
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
          )
        )
          .get_child_value(0)
          .get_uint64();
        logger.log(`idle time: ${toTimeString(idleTime / 1000)}`);
        const lastActiveTime = Math.floor((Date.now() - idleTime) / 1000);
        // Workaround for https://github.com/projecthamster/hamster/issues/775
        const endTime = lastActiveTime - new Date().getTimezoneOffset() * 60;
        try {
          await this._hamsterProxy!.call(
            "StopTracking",
            new GLib.Variant("(i)", [endTime]),
            Gio.DBusCallFlags.NONE,
            -1,
            null
          );
        } catch (e) {
          logger.log(`error: ${e}`);
        }
      }
    );
    await this.connectSettingsKeyChange(
      undefined,
      "use-session-idle-delay",
      this.updateSessionIdleSync.bind(this)
    );
    await this.connectSettingsKeyChange(
      undefined,
      "idle-delay",
      this.updateIdleWatch.bind(this)
    );
  }

  async disable(): Promise<void> {
    const logger = this.getLogger();
    await this.removeIdleWatch();
    for (let [schema, handlerIds] of this._settingsHandlerIds ?? []) {
      const settings = this._settings!.get(schema);
      for (let [key, handlerId] of handlerIds) {
        settings?.disconnect(handlerId);
        logger.log(
          `disconnected from changes to ${schema}.${key} with handler ID ${handlerId}`
        );
      }
      handlerIds.clear();
    }
    this._settingsHandlerIds?.clear();
    this._settingsHandlerIds = undefined;
    this._settings?.clear();
    this._settings = undefined;
    if (this._watchFiredHandlerId != undefined) {
      this._idleMonitorProxy!.disconnect(this._watchFiredHandlerId);
      this._watchFiredHandlerId = undefined;
    }
    this._idleMonitorProxy = undefined;
    this._hamsterProxy = undefined;
    logger.log("disabled");
  }

  async removeIdleWatch(): Promise<void> {
    if (this._watchId != undefined) {
      await this._idleMonitorProxy!.call(
        "RemoveWatch",
        new GLib.Variant("(u)", [this._watchId]),
        Gio.DBusCallFlags.NONE,
        -1,
        null
      );
      this.getLogger().log(`remove watch with ID ${this._watchId}`);
      this._watchId = undefined;
    }
  }

  async connectSettingsKeyChange<T>(
    schema: string | undefined,
    key: string,
    callback: (value: T) => Promise<void>
  ): Promise<void> {
    const logger = this.getLogger();
    schema = schema ?? this.metadata["settings-schema"];
    const existingHandlerId = this._settingsHandlerIds?.get(schema!)?.get(key);
    if (existingHandlerId != undefined) {
      return;
    }
    let settings = this._settings?.get(schema!);
    if (settings == undefined) {
      if (this._settings == undefined) {
        this._settings = new Map();
      }
      settings = this.getSettings(schema!);
      this._settings?.set(schema!, settings);
    }
    const handlerId = settings.connect(
      `changed::${key}`,
      async (settings: Gio.Settings, key: string): Promise<void> => {
        const value: T = settings.get_value(key).recursiveUnpack();
        logger.log(`changed ${settings.schema_id}.${key}=${value}`);
        await callback(value);
      }
    );
    logger.log(
      `connected to changes of ${schema}.${key} with handler ID ${handlerId}`
    );
    // Need to always access a key after connecting for changes
    await callback(settings!.get_value(key).recursiveUnpack());
    let handlerIds = this._settingsHandlerIds?.get(schema!);
    if (handlerIds == undefined) {
      handlerIds = new Map();
      if (this._settingsHandlerIds == undefined) {
        this._settingsHandlerIds = new Map();
      }
      this._settingsHandlerIds.set(schema!, handlerIds);
    }
    handlerIds.set(key, handlerId);
  }

  disconnectSettingsKeyChange(schema: string | undefined, key: string): void {
    const logger = this.getLogger();
    schema = schema ?? this.metadata["settings-schema"];
    const handlerIds = this._settingsHandlerIds?.get(schema!);
    const handlerId = handlerIds?.get(key);
    if (handlerId != undefined) {
      this._settings!.get(schema!)?.disconnect(handlerId);
      handlerIds?.delete(key);
      logger.log(
        `disconnected from changes to ${schema}.${key} with handler ID ${handlerId}`
      );
    }
  }

  async updateSessionIdleDelay(idleDelaySec: number): Promise<void> {
    const settings = this.getSettings();
    if (idleDelaySec == 0) {
      // Idle delay of 0 means it's been disabled
      // so disable the sync ourselves
      settings.set_value(
        "use-session-idle-delay",
        GLib.Variant.new_boolean(false)
      );
    } else {
      settings.set_value(
        "idle-delay",
        GLib.Variant.new_uint16(idleDelaySec + IDLE_DELAY_OFFSET_SEC)
      );
    }
  }

  async updateSessionIdleSync(useSessionIdleDelay: boolean): Promise<void> {
    const schema = "org.gnome.desktop.session";
    const key = "idle-delay";
    if (useSessionIdleDelay) {
      await this.connectSettingsKeyChange(
        schema,
        key,
        this.updateSessionIdleDelay.bind(this)
      );
    } else {
      this.disconnectSettingsKeyChange(schema, key);
    }
  }

  async updateIdleWatch(idleTimeSec: number): Promise<void> {
    const logger = this.getLogger();
    await this.removeIdleWatch();
    const idleTimeMs = idleTimeSec * 1000;
    const watchId = (
      await this._idleMonitorProxy!.call(
        "AddIdleWatch",
        new GLib.Variant("(t)", [idleTimeMs]),
        Gio.DBusCallFlags.NONE,
        -1,
        null
      )
    )
      .get_child_value(0)
      .get_uint32();
    this._watchId = watchId;
    logger.log(
      `add idle watch for ${toTimeString(idleTimeSec)} with ID ${watchId}`
    );
  }
}
