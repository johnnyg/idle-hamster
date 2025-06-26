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

import { ConsoleLike } from "@girs/gnome-shell/extensions/extension";
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
  logger: ConsoleLike,
  settings: Gio.Settings,
  key: string,
  callback: (value: T) => Promise<void>
): Promise<SignalConnection> {
  const handlerId = settings.connect(
    `changed::${key}`,
    async (settings: Gio.Settings, key: string): Promise<void> => {
      const value: T = settings.get_value(key).recursiveUnpack();
      logger.info(`changed ${settings.schema_id}.${key}=${value}`);
      await callback(value);
    }
  );
  logger.debug(
    `connected to changes of ${settings.schemaId}.${key} with handler ID ${handlerId}`
  );
  // Need to always access a key after connecting for changes
  await callback(settings!.get_value(key).recursiveUnpack());
  return {
    async disconnect(): Promise<void> {
      settings.disconnect(handlerId);
      logger.debug(
        `disconnected from changes to ${settings.schemaId}.${key} with handler ID ${handlerId}`
      );
    },
  };
}

async function connectProxySignal<T>(
  logger: ConsoleLike,
  proxy: Gio.DBusProxy,
  signal: string,
  callback: (value: T) => Promise<void>
): Promise<SignalConnection> {
  const handlerId = proxy.connect(
    `g-signal::${signal}`,
    async (
      source: Gio.DBusProxy,
      _senderName: string | null,
      signalName: string,
      parameters: GLib.Variant
    ) => {
      const value = parameters.recursiveUnpack();
      logger.info(
        `received signal ${signalName}=${value} from ${source.get_interface_name()}`
      );
      await callback(value);
    }
  );
  logger.debug(
    `connected to signal '${signal}' of ${proxy.get_interface_name()} with handler ID ${handlerId}`
  );
  return {
    async disconnect(): Promise<void> {
      proxy.disconnect(handlerId);
      logger.debug(
        `disconnected from signal '${signal}' of ${proxy.get_interface_name()} with handler ID ${handlerId}`
      );
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
    logger.debug("enabled");
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
        logger,
        this._idleMonitorProxy,
        "WatchFired",
        this.stopTracking.bind(this)
      )
    );
    this._signals!.set(
      "useSessionIdleDelay",
      await connectSettingsKeyChangeSignal(
        logger,
        this._settings,
        "use-session-idle-delay",
        this.updateSessionIdleSync.bind(this)
      )
    );
    this._signals!.set(
      "idleDelay",
      await connectSettingsKeyChangeSignal(
        logger,
        this._settings,
        "idle-delay",
        this.updateIdleWatchSignal.bind(this)
      )
    );
    this._signals!.set(
      "stopOnLock",
      await connectSettingsKeyChangeSignal(
        logger,
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
    logger.debug("disabled");
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
    logger.info(`idle time: ${toTimeString(idleTime / 1000)}`);
    const lastActiveTime = Math.floor((Date.now() - idleTime) / 1000);
    // Workaround for https://github.com/projecthamster/hamster/issues/775
    const endTime = lastActiveTime - new Date().getTimezoneOffset() * 60;
    logger.log(
      `stopping hamster activity tracking; user last active at ${lastActiveTime}`
    );
    try {
      await this._hamsterProxy!.call(
        "StopTracking",
        new GLib.Variant("(i)", [endTime]),
        Gio.DBusCallFlags.NONE,
        -1,
        null
      );
    } catch (e) {
      logger.error(`error: ${e}`);
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
          this.getLogger(),
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
          logger,
          this._screensaverProxy!,
          "ActiveChanged",
          async (active: boolean): Promise<void> => {
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
    const method = "AddIdleWatch";
    const proxy = this._idleMonitorProxy!;
    const watchId = await proxy.call(
      method,
      new GLib.Variant("(t)", [idleTimeMs]),
      Gio.DBusCallFlags.NONE,
      -1,
      null
    );
    const watchIdStr = watchId.print(false);
    logger.debug(
      `${proxy.get_interface_name()}.${method}(${toTimeString(
        idleTimeSec
      )}) -> ${watchIdStr}`
    );
    return {
      async disconnect(): Promise<void> {
        const method = "RemoveWatch";
        await proxy.call(method, watchId, Gio.DBusCallFlags.NONE, -1, null);
        logger.debug(`${proxy.get_interface_name()}.${method}(${watchIdStr})`);
      },
    };
  }
}
