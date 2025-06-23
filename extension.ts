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

interface SignalConnection {
  disconnect(): Promise<void>;
}

async function connectSettingsKeyChangeSignal<T>(
  settings: Gio.Settings,
  key: string,
  callback: (value: T) => Promise<void>
): Promise<SignalConnection> {
  const logger = console;
  const handlerId = settings.connect(
    `changed::${key}`,
    async (settings: Gio.Settings, key: string): Promise<void> => {
      const value: T = settings.get_value(key).recursiveUnpack();
      logger.log(`changed ${settings.schema_id}.${key}=${value}`);
      await callback(value);
    }
  );
  logger.log(
    `connected to changes of ${settings.schemaId}.${key} with handler ID ${handlerId}`
  );
  // Need to always access a key after connecting for changes
  await callback(settings!.get_value(key).recursiveUnpack());
  return {
    async disconnect(): Promise<void> {
      settings.disconnect(handlerId);
      logger.log(
        `disconnected from changes to ${settings.schemaId}.${key} with handler ID ${handlerId}`
      );
    },
  };
}

async function connectProxySignal<T>(
  proxy: Gio.DBusProxy,
  signal: string,
  callback: (value: T) => Promise<void>
): Promise<SignalConnection> {
  const handlerId = proxy.connect(
    `g-signal::${signal}`,
    async (
      _source: Gio.DBusProxy,
      _senderName: string | null,
      _signalName: string,
      parameters: GLib.Variant
    ) => {
      const value = parameters.recursiveUnpack();
      await callback(value);
    }
  );
  return {
    async disconnect(): Promise<void> {
      proxy.disconnect(handlerId);
    },
  };
}

function toTimeString(sec: number): string {
  return `${Math.floor(sec / 60)} min ${Math.floor(sec % 60)} sec`;
}

export default class IdleHamsterExtension extends Extension {
  _hamsterProxy?: Gio.DBusProxy;
  _idleMonitorProxy?: Gio.DBusProxy;
  _screensaverProxy?: Gio.DBusProxy;
  _settings?: Gio.Settings;
  _signals?: Map<string, SignalConnection>;

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
    this._settings = this.getSettings();
    this._signals = new Map();
    this._signals!.set(
      "watchFired",
      await connectProxySignal(
        this._idleMonitorProxy,
        "WatchFired",
        this.stopTracking.bind(this)
      )
    );
    this._signals!.set(
      "useSessionIdleDelay",
      await connectSettingsKeyChangeSignal(
        this._settings,
        "use-session-idle-delay",
        this.updateSessionIdleSync.bind(this)
      )
    );
    this._signals!.set(
      "idleDelay",
      await connectSettingsKeyChangeSignal(
        this._settings,
        "idle-delay",
        this.updateIdleWatchSignal.bind(this)
      )
    );
    this._signals!.set(
      "stopOnLock",
      await connectSettingsKeyChangeSignal(
        this._settings,
        "stop-on-lock",
        this.updateStopOnLock.bind(this)
      )
    );
  }

  async disable(): Promise<void> {
    const logger = this.getLogger();
    for (let [_signalId, signal] of this._signals ?? []) {
      signal?.disconnect();
    }
    this._signals?.clear();
    this._settings = undefined;
    this._idleMonitorProxy = undefined;
    this._screensaverProxy = undefined;
    this._hamsterProxy = undefined;
    logger.log("disabled");
  }

  async stopTracking(): Promise<void> {
    const logger = this.getLogger();
    const [idleTime] = (
      await this._idleMonitorProxy!.call(
        "GetIdletime",
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null
      )
    ).recursiveUnpack();
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

  async updateSessionIdleDelay(idleDelaySec: number): Promise<void> {
    if (idleDelaySec == 0) {
      // Idle delay of 0 means it's been disabled
      // so disable the sync ourselves
      this._settings!.set_value(
        "use-session-idle-delay",
        GLib.Variant.new_boolean(false)
      );
    } else {
      this._settings!.set_value(
        "idle-delay",
        GLib.Variant.new_uint16(idleDelaySec + IDLE_DELAY_OFFSET_SEC)
      );
    }
  }

  async updateSessionIdleSync(useSessionIdleDelay: boolean): Promise<void> {
    const schema = "org.gnome.desktop.session";
    const settings = this.getSettings(schema);
    const key = "idle-delay";
    const signalId = "sessionIdleDelay";
    this._signals!.get(signalId)?.disconnect();
    if (useSessionIdleDelay) {
      this._signals!.set(
        signalId,
        await connectSettingsKeyChangeSignal(
          settings,
          key,
          this.updateSessionIdleDelay.bind(this)
        )
      );
    } else {
      this._signals!.delete(signalId);
    }
  }

  async updateIdleWatchSignal(idleTimeSec: number): Promise<void> {
    this._signals!.get("idleWatch")?.disconnect();
    this._signals!.set(
      "idleWatch",
      await this.connectIdleWatchSignal(idleTimeSec)
    );
  }

  async updateStopOnLock(stopOnLock: boolean): Promise<void> {
    const logger = this.getLogger();
    const signalId = "activeChanged";
    this._signals!.get(signalId)?.disconnect();
    if (stopOnLock) {
      if (this._screensaverProxy === undefined) {
        this._screensaverProxy = await (
          Gio.DBusProxy.new_for_bus as GioDBusProxyNewForBus
        )(
          Gio.BusType.SESSION,
          Gio.DBusProxyFlags.NONE,
          null,
          "org.gnome.ScreenSaver",
          "/org/gnome/ScreenSaver",
          "org.gnome.ScreenSaver",
          null
        );
      }
      this._signals!.set(
        signalId,
        await connectProxySignal(
          this._screensaverProxy!,
          "ActiveChanged",
          async (active: boolean): Promise<void> => {
            logger.log(`screensaver active: ${active}`);
            if (active) {
              this.stopTracking();
            }
          }
        )
      );
    } else {
      this._signals!.delete(signalId);
      this._screensaverProxy = undefined;
    }
  }

  async connectIdleWatchSignal(idleTimeSec: number): Promise<SignalConnection> {
    const logger = this.getLogger();
    const idleTimeMs = idleTimeSec * 1000;
    const watchId = await this._idleMonitorProxy!.call(
      "AddIdleWatch",
      new GLib.Variant("(t)", [idleTimeMs]),
      Gio.DBusCallFlags.NONE,
      -1,
      null
    );
    logger.log(
      `add idle watch for ${toTimeString(idleTimeSec)} with ID ${watchId}`
    );
    const proxy = this._idleMonitorProxy;
    return {
      async disconnect(): Promise<void> {
        await proxy!.call(
          "RemoveWatch",
          watchId,
          Gio.DBusCallFlags.NONE,
          -1,
          null
        );
        logger.log(`remove watch with ID ${watchId}`);
      },
    };
  }
}
